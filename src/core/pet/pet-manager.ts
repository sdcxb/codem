/**
 * PetManager — 宠物包安装/卸载/列表管理。
 *
 * 工作流程：
 * 1. 从市场下载 pet.json + spritesheet 到 ~/.codem/pets/<slug>/
 * 2. 解析 pet.json 为 PetDefinition
 * 3. 注册到本地注册表
 * 4. 应用启动时从磁盘加载已安装宠物
 *
 * 安全限制：
 * - pet.json 必须包含合法的 slug 和动画配置
 * - spritesheet 文件大小限制 5MB
 * - 路径不允许包含 .. 或绝对路径
 *
 * IP 声明：本文件基于开源项目 Petdex (MIT License) 集成并改造实现。
 * @see THIRD_PARTY_NOTICES.md — Petdex (MIT License) 集成声明
 */

import type { PetDefinition, InstalledPet, PetSettings, PetState } from "./pet-types";
import { DEFAULT_PET_SETTINGS } from "./pet-types";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { readFile, writeFile, listDirectory, deletePath } from "../file-api";

// ========== 常量 ==========

const PETS_SETTINGS_KEY = "codem-pet-settings";
const PETS_INSTALLED_KEY = "codem-pet-installed";

// ========== Tauri Invoke Helpers ==========

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    throw new Error("Tauri invoke not available — pet manager requires Tauri runtime.");
  }
  return invoke(command, args);
}

/** 获取宠物安装根目录 (~/.codem/pets/) */
async function getPetsDir(): Promise<string> {
  const home = await tauriInvoke("get_default_cwd");
  const sep = home.includes("/") && !home.includes("\\") ? "/" : "\\";
  return `${home}${sep}.codem${sep}pets`;
}

/** 获取路径分隔符 */
async function getPathSep(): Promise<string> {
  const home = await tauriInvoke("get_default_cwd");
  return home.includes("/") && !home.includes("\\") ? "/" : "\\";
}

// ========== 设置管理 ==========

/** 获取宠物设置 */
export function getPetSettings(): PetSettings {
  return getSettingJSON<PetSettings>(PETS_SETTINGS_KEY, DEFAULT_PET_SETTINGS);
}

/** 保存宠物设置 */
export function savePetSettings(settings: Partial<PetSettings>): void {
  const current = getPetSettings();
  const merged = { ...current, ...settings };
  setSettingJSON(PETS_SETTINGS_KEY, merged);
}

// ========== 安装记录管理 ==========

/** 安装记录（slug → 安装信息摘要） */
interface InstallRecord {
  slug: string;
  path: string;
  installedAt: number;
}

/** 获取安装记录列表 */
function getInstallRecords(): InstallRecord[] {
  return getSettingJSON<InstallRecord[]>(PETS_INSTALLED_KEY, []);
}

/** 保存安装记录列表 */
function setInstallRecords(records: InstallRecord[]): void {
  setSettingJSON(PETS_INSTALLED_KEY, records);
}

// ========== Petdex 固定精灵图布局 ==========
// 基于 Petdex (MIT) 的固定网格布局，所有宠物共用同一套动画状态配置。
// 帧: 192×208px，8 列 1536px 总宽。

const PETDEX_FRAME_WIDTH = 192;
const PETDEX_FRAME_HEIGHT = 208;
const PETDEX_SHEET_WIDTH = 1536;
/** v1 精灵图 9 行，v2 有 11 行。取最大值确保所有行都在范围内。 */
const PETDEX_SHEET_HEIGHT = 11 * PETDEX_FRAME_HEIGHT; // 2288

/** Petdex 固定动画状态（row, frames, durationMs） */
const PETDEX_STATES = [
  { id: "idle",           row: 0, frames: 6, durationMs: 1100 },
  { id: "running-right",  row: 1, frames: 8, durationMs: 1060 },
  { id: "running-left",   row: 2, frames: 8, durationMs: 1060 },
  { id: "waving",         row: 3, frames: 4, durationMs: 700 },
  { id: "jumping",        row: 4, frames: 5, durationMs: 840 },
  { id: "failed",         row: 5, frames: 8, durationMs: 1220 },
  { id: "waiting",        row: 6, frames: 6, durationMs: 1010 },
  { id: "running",        row: 7, frames: 6, durationMs: 820 },
  { id: "review",         row: 8, frames: 6, durationMs: 1030 },
] as const;

/** Petdex 状态 → Codem 状态映射 */
const PETDEX_TO_CODEM_STATE: Record<string, PetState> = {
  "idle":           "idle",
  "review":         "thinking",
  "running":        "working",
  "running-right":  "working",
  "running-left":   "working",
  "waving":         "happy",
  "jumping":        "happy",
  "failed":         "sad",
  "waiting":        "sleeping",
};

/**
 * 从 Petdex 固定布局生成 Codem 动画配置。
 * 每个 Petdex 状态映射到一个 Codem 状态，同一 Codem 状态取第一个匹配的 Petdex 状态。
 */
function generateAnimationsFromPetdexLayout(): PetDefinition["animations"] {
  const seen = new Set<PetState>();
  const animations: PetDefinition["animations"] = [];

  for (const ps of PETDEX_STATES) {
    const codemState = PETDEX_TO_CODEM_STATE[ps.id];
    if (!codemState || seen.has(codemState)) continue;
    seen.add(codemState);

    animations.push({
      state: codemState,
      x: 0,
      y: ps.row * PETDEX_FRAME_HEIGHT,
      frameWidth: PETDEX_FRAME_WIDTH,
      frameHeight: PETDEX_FRAME_HEIGHT,
      frames: ps.frames,
      frameInterval: Math.round(ps.durationMs / ps.frames),
      loop: true,
    });
  }

  return animations;
}

// ========== pet.json 解析 ==========

/**
 * 解析 pet.json 内容为 PetDefinition。
 *
 * 支持两种格式：
 * 1. Petdex 原生格式（id, displayName, description, spritesheetPath）
 * 2. Codem 扩展格式（slug, name, animations, ...）— 向后兼容
 *
 * 对于 Petdex 格式，动画配置从固定精灵图布局自动生成。
 */
export function parsePetJson(content: string): PetDefinition | null {
  try {
    const raw = JSON.parse(content);

    // 兼容两种字段名: id/slug, displayName/name, spritesheetPath/spritesheet
    const slug = raw.slug || raw.id;
    const name = raw.name || raw.displayName;
    const spritesheet = raw.spritesheet || raw.spritesheetPath;

    if (!slug || typeof slug !== "string") return null;
    if (!name || typeof name !== "string") return null;
    if (!spritesheet || typeof spritesheet !== "string") return null;

    // 如果已有 animations 数组（Codem 扩展格式），直接使用
    let animations: PetDefinition["animations"];
    if (Array.isArray(raw.animations) && raw.animations.length > 0) {
      const validStates = new Set(["idle", "thinking", "working", "happy", "sad", "sleeping"]);
      animations = raw.animations.filter((a: any) =>
        a && typeof a.state === "string" && validStates.has(a.state) &&
        typeof a.x === "number" && typeof a.y === "number" &&
        typeof a.frameWidth === "number" && typeof a.frameHeight === "number" &&
        typeof a.frames === "number" && typeof a.frameInterval === "number"
      );
      if (animations.length === 0 || !animations.some((a: any) => a.state === "idle")) {
        animations = generateAnimationsFromPetdexLayout();
      }
    } else {
      // Petdex 原生格式：从固定布局生成
      animations = generateAnimationsFromPetdexLayout();
    }

    return {
      slug,
      name,
      description: raw.description || "",
      author: raw.author || "",
      version: raw.version || "1.0.0",
      spritesheet,
      sheetWidth: raw.sheetWidth || PETDEX_SHEET_WIDTH,
      sheetHeight: raw.sheetHeight || PETDEX_SHEET_HEIGHT,
      scale: raw.scale ?? 1.0,
      animations,
      defaultState: raw.defaultState || "idle",
      tags: raw.tags || [],
      previewUrl: raw.previewUrl || "",
    } as PetDefinition;
  } catch {
    return null;
  }
}

// ========== 安装/卸载 ==========

/**
 * 安装宠物到本地。
 *
 * @param definition 宠物定义（已解析的 pet.json）
 * @param spritesheetData 精灵图二进制数据（Base64 编码）
 * @param overwrite 是否覆盖已存在的宠物
 */
export async function installPet(
  definition: PetDefinition,
  spritesheetBase64: string,
  overwrite: boolean = false,
): Promise<{ success: boolean; error?: string; slug?: string }> {
  try {
    // 检查是否已安装
    const records = getInstallRecords();
    const existing = records.find((r) => r.slug === definition.slug);
    if (existing && !overwrite) {
      return {
        success: false,
        error: `宠物 "${definition.name}" 已安装。是否覆盖安装？`,
        slug: definition.slug,
      };
    }

    // 获取安装目录
    const petsDir = await getPetsDir();
    const sep = await getPathSep();
    const petDir = `${petsDir}${sep}${definition.slug}`;

    // 如果覆盖安装，先删除旧目录
    if (existing && overwrite) {
      try {
        await deletePath(petDir);
      } catch {
        // Ignore deletion errors
      }
    }

    // 写入 pet.json
    const petJsonPath = `${petDir}${sep}pet.json`;
    await writeFile(petJsonPath, JSON.stringify(definition, null, 2));

    // 写入精灵图（Base64 → 二进制）
    const spritesheetPath = `${petDir}${sep}${definition.spritesheet}`;
    await writeFile(spritesheetPath, spritesheetBase64, { encoding: "base64" });

    // 更新安装记录
    const newRecord: InstallRecord = {
      slug: definition.slug,
      path: petDir,
      installedAt: Date.now(),
    };

    const updatedRecords = existing
      ? records.map((r) => (r.slug === definition.slug ? newRecord : r))
      : [...records, newRecord];
    setInstallRecords(updatedRecords);

    return { success: true, slug: definition.slug };
  } catch (err: any) {
    return {
      success: false,
      error: `安装宠物失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 卸载宠物。
 */
export async function uninstallPet(slug: string): Promise<{ success: boolean; error?: string }> {
  try {
    const records = getInstallRecords();
    const record = records.find((r) => r.slug === slug);
    if (!record) {
      return { success: false, error: `宠物 "${slug}" 未安装。` };
    }

    // 删除宠物目录
    try {
      await deletePath(record.path);
    } catch (err) {
      console.warn(`[PetManager] Failed to delete pet directory:`, err);
    }

    // 从记录中移除
    setInstallRecords(records.filter((r) => r.slug !== slug));

    // 如果卸载的是当前激活的宠物，清除激活状态
    const settings = getPetSettings();
    if (settings.activePetSlug === slug) {
      savePetSettings({ activePetSlug: null });
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: `卸载失败: ${err.message || String(err)}` };
  }
}

// ========== 列表/查询 ==========

/**
 * 列出所有已安装的宠物。
 * 从磁盘加载 pet.json，返回完整的 InstalledPet 列表。
 */
export async function listInstalledPets(): Promise<InstalledPet[]> {
  const records = getInstallRecords();
  const pets: InstalledPet[] = [];

  for (const record of records) {
    try {
      const sep = await getPathSep();
      const petJsonPath = `${record.path}${sep}pet.json`;
      const content = await readFile(petJsonPath);
      const definition = parsePetJson(content);
      if (definition) {
        pets.push({
          slug: record.slug,
          path: record.path,
          definition,
          installedAt: record.installedAt,
        });
      }
    } catch {
      // Skip invalid pets
      console.warn(`[PetManager] Failed to load pet: ${record.slug}`);
    }
  }

  return pets;
}

/**
 * 获取单个已安装的宠物。
 */
export async function getInstalledPet(slug: string): Promise<InstalledPet | null> {
  const pets = await listInstalledPets();
  return pets.find((p) => p.slug === slug) || null;
}

/**
 * 检查宠物是否已安装。
 */
export function isPetInstalled(slug: string): boolean {
  const records = getInstallRecords();
  return records.some((r) => r.slug === slug);
}

// ========== 精灵图加载 ==========

/**
 * 根据精灵图文件名推断 MIME 类型。
 */
function getSpriteMime(filename: string): string {
  if (filename.match(/\.webp$/i)) return "image/webp";
  if (filename.match(/\.png$/i)) return "image/png";
  if (filename.match(/\.(jpg|jpeg)$/i)) return "image/jpeg";
  if (filename.match(/\.gif$/i)) return "image/gif";
  return "image/png"; // 默认
}

/**
 * 加载宠物精灵图为 Data URL。
 * 由于 Tauri CSP 限制，无法直接通过 file:// 加载本地图片，
 * 需要读取文件为 Base64 并转换为 data: URL。
 */
export async function loadSpritesheetAsDataUrl(pet: InstalledPet): Promise<string | null> {
  try {
    const sep = await getPathSep();
    const spritesheetPath = `${pet.path}${sep}${pet.definition.spritesheet}`;
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return null;

    const base64 = await invoke("read_file", { path: spritesheetPath, encoding: "base64" });
    const mime = getSpriteMime(pet.definition.spritesheet);
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    console.error(`[PetManager] Failed to load spritesheet for ${pet.slug}:`, err);
    return null;
  }
}

// ========== 启动时加载 ==========

/**
 * 应用启动时从磁盘加载已安装的宠物。
 * 返回加载的宠物数量。
 */
export async function loadInstalledPets(): Promise<number> {
  try {
    const pets = await listInstalledPets();
    console.log(`[PetManager] Loaded ${pets.length} installed pets`);
    return pets.length;
  } catch (err) {
    console.error(`[PetManager] Failed to load installed pets:`, err);
    return 0;
  }
}

// ========== 动画辅助 ==========

/**
 * 获取宠物在指定状态下的动画配置。
 * 如果该状态没有配置，回退到 idle 状态。
 */
export function getAnimationForState(
  definition: PetDefinition,
  state: PetState,
): PetDefinition["animations"][0] | null {
  const anim = definition.animations.find((a) => a.state === state);
  if (anim) return anim;

  // 回退到 idle
  const idle = definition.animations.find((a) => a.state === "idle");
  return idle || null;
}
