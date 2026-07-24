/**
 * PetMarketClient — 宠物市场客户端。
 *
 * 架构方案：通过 Tauri Rust 层的 http_get / http_download 命令代理 HTTP 请求，
 * 绕过前端 CSP 限制和 Petdex R2 资源的 Referer 检查。
 *
 * 数据源：
 * - Petdex Manifest API (https://petdex.dev/api/manifest): 公开 API，307 重定向到 R2 CDN JSON
 * - Petdex R2 资产 CDN (https://assets.petdex.dev): spritesheet / pet.json，需 Referer 头
 *
 * IP 声明：本文件接入开源项目 Petdex (MIT License) 的市场 API，调用 Petdex 开源项目的宠物市场。
 * @see THIRD_PARTY_NOTICES.md — Petdex (MIT License) 集成声明
 */

import type { MarketPet, PetDefinition } from "./pet-types";
import { parsePetJson, installPet, isPetInstalled } from "./pet-manager";

// ========== 常量 ==========

/** Petdex v1 Manifest API URL — 返回具名字段 + 完整 URL，格式最简单 */
const PETDEX_MANIFEST_V1_URL = "https://petdex.dev/api/manifest";

/** Petdex v2 Manifest API URL — 返回数组元组格式 + assetBase */
const PETDEX_MANIFEST_V2_URL = "https://petdex.dev/api/manifest/v2";

/** Petdex 网站基础 URL（用于 Referer 头） */
const PETDEX_BASE_URL = "https://petdex.dev";

/** R2 资产 CDN 基础 URL */
const PETDEX_R2_BASE = "https://assets.petdex.dev";

/** 下载宠物素材时的 Referer 头（绕过 R2 Worker 的 Referer 检查）
 * R2 Worker 仅允许以下 Referer 前缀：
 * - http://localhost / https://localhost
 * - https://petdex.dev/
 */
const PETDEX_REFERER_HEADERS: Record<string, string> = {
  "Referer": PETDEX_BASE_URL + "/",
};

// ========== Tauri Invoke Helpers ==========

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    throw new Error("Tauri invoke not available — pet market requires Tauri runtime.");
  }
  return invoke(command, args);
}

/** HTTP GET（通过 Rust 代理） */
async function httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return tauriInvoke("http_get", { url, headers });
}

/** HTTP 下载文件（通过 Rust 代理） */
async function httpDownload(url: string, destPath: string, headers?: Record<string, string>): Promise<string> {
  return tauriInvoke("http_download", { url, destPath, headers });
}

// ========== Manifest 解析 ==========

/** v1 Manifest 条目（具名字段 + 完整 URL） */
interface PetdexV1Item {
  slug: string;
  displayName: string;
  kind: string;
  submittedBy: string | null;
  spritesheetUrl: string;
  petJsonUrl: string;
  zipUrl: string | null;
}

/** v2 Manifest 响应（数组元组格式） */
interface PetdexV2Manifest {
  v: 2;
  generatedAt: string;
  total: number;
  assetBase: string;
  fields: string[];
  pets: any[][]; // 元组数组，顺序对应 fields
}

/** v1 Manifest 响应 */
interface PetdexV1Manifest {
  generatedAt: string;
  total: number;
  pets: PetdexV1Item[];
}

/**
 * 将 v1 Manifest 条目转换为 MarketPet。
 * v1 格式已有完整 URL，直接映射。
 */
function normalizeV1Item(item: PetdexV1Item): MarketPet | null {
  if (!item.slug || !item.displayName) return null;

  return {
    id: `petdex:${item.slug}`,
    slug: item.slug,
    name: item.displayName,
    description: `Kind: ${item.kind}${item.submittedBy ? ` · by ${item.submittedBy}` : ""}`,
    author: item.submittedBy || "",
    version: "",
    tags: [item.kind].filter(Boolean),
    previewUrl: `${PETDEX_R2_BASE}/pets/${item.slug}/preview.webp`,
    metadataUrl: item.petJsonUrl,
    spritesheetUrl: item.spritesheetUrl,
    downloads: undefined,
    lastUpdated: undefined,
    installed: isPetInstalled(item.slug),
  };
}

/**
 * 将 v2 Manifest 元组转换为 MarketPet。
 * v2 格式：pets 是元组数组，字段顺序对应 fields 数组。
 * 典型 fields: ["slug", "displayName", "kind", "submittedBy", "spritesheet", "petJson", "zip"]
 * spritesheet/petJson 是 R2 key（相对路径），需拼接 assetBase。
 */
function normalizeV2Item(row: any[], fields: string[], assetBase: string): MarketPet | null {
  // 将元组转为对象
  const obj: Record<string, any> = {};
  for (let i = 0; i < fields.length && i < row.length; i++) {
    obj[fields[i]] = row[i];
  }

  if (!obj.slug || !obj.displayName) return null;

  // R2 key → 完整 URL
  const toFullUrl = (key: string | null | undefined): string | undefined => {
    if (!key) return undefined;
    if (key.startsWith("http")) return key;
    return `${assetBase}/${key.replace(/^\/+/, "")}`;
  };

  return {
    id: `petdex:${obj.slug}`,
    slug: obj.slug,
    name: obj.displayName,
    description: `Kind: ${obj.kind || ""}${obj.submittedBy ? ` · by ${obj.submittedBy}` : ""}`,
    author: obj.submittedBy || "",
    version: "",
    tags: [obj.kind].filter(Boolean),
    previewUrl: `${PETDEX_R2_BASE}/pets/${obj.slug}/preview.webp`,
    metadataUrl: toFullUrl(obj.petJson) || "",
    spritesheetUrl: toFullUrl(obj.spritesheet) || "",
    downloads: undefined,
    lastUpdated: undefined,
    installed: isPetInstalled(obj.slug),
  };
}

// ========== 公共 API ==========

/**
 * 从 Petdex 市场获取宠物目录。
 *
 * 策略：优先使用 v1 Manifest（具名字段 + 完整 URL），
 * 如果 v1 失败则回退到 v2 Manifest（数组元组格式）。
 *
 * Rust http_get 默认跟随 307 重定向，所以 manifest API → R2 CDN 的重定向是透明的。
 *
 * @param onProgress 每个阶段完成时的回调（用于 UI 进度展示）
 * @returns 宠物列表
 */
export async function listMarketPets(
  onProgress?: (message: string) => void,
): Promise<{ pets: MarketPet[]; error?: string }> {
  try {
    onProgress?.("正在连接宠物市场...");

    // 尝试 v1 manifest（格式最简单）
    const resp = await httpGet(PETDEX_MANIFEST_V1_URL);

    if (resp.status !== 200) {
      // v1 失败，尝试 v2
      onProgress?.("正在尝试备用数据源...");
      return await listMarketPetsV2();
    }

    onProgress?.("正在解析宠物目录...");

    let data: any;
    try {
      data = JSON.parse(resp.body);
    } catch {
      // v1 解析失败，尝试 v2
      return await listMarketPetsV2();
    }

    const items: PetdexV1Item[] = Array.isArray(data) ? data : (data.pets || []);
    const pets: MarketPet[] = [];
    for (const item of items) {
      const normalized = normalizeV1Item(item);
      if (normalized) {
        pets.push(normalized);
      }
    }

    if (pets.length === 0) {
      // v1 返回空，尝试 v2
      return await listMarketPetsV2();
    }

    onProgress?.(`找到 ${pets.length} 个宠物`);
    return { pets };
  } catch (err: any) {
    // v1 完全失败，尝试 v2
    try {
      return await listMarketPetsV2();
    } catch {
      return {
        pets: [],
        error: `获取宠物市场失败: ${err.message || String(err)}`,
      };
    }
  }
}

/** v2 manifest 回退 */
async function listMarketPetsV2(): Promise<{ pets: MarketPet[]; error?: string }> {
  const resp = await httpGet(PETDEX_MANIFEST_V2_URL);
  if (resp.status !== 200) {
    return { pets: [], error: `市场请求失败: HTTP ${resp.status}` };
  }

  const data: PetdexV2Manifest = JSON.parse(resp.body);
  const assetBase = data.assetBase || PETDEX_R2_BASE;
  const fields = data.fields || ["slug", "displayName", "kind", "submittedBy", "spritesheet", "petJson", "zip"];

  const pets: MarketPet[] = [];
  for (const row of data.pets || []) {
    const normalized = normalizeV2Item(row, fields, assetBase);
    if (normalized) {
      pets.push(normalized);
    }
  }

  return { pets };
}

/**
 * 下载并安装市场宠物。
 *
 * 流程：
 * 1. 通过 Rust 代理下载 pet.json（带 Referer 头）
 * 2. 解析 pet.json 为 PetDefinition
 * 3. 通过 Rust 代理下载 spritesheet（带 Referer 头）
 * 4. 调用 installPet 写入本地
 *
 * @param pet 市场宠物条目
 * @param onProgress 安装进度回调
 * @param overwrite 是否覆盖已存在的宠物
 */
export async function installMarketPet(
  pet: MarketPet,
  onProgress?: (progress: number, message: string) => void,
  overwrite: boolean = false,
): Promise<{ success: boolean; error?: string; slug?: string }> {
  try {
    onProgress?.(10, "正在下载宠物元数据...");

    // 1. 下载 pet.json
    const metadataResp = await httpGet(pet.metadataUrl, PETDEX_REFERER_HEADERS);
    if (metadataResp.status !== 200) {
      return {
        success: false,
        error: `下载宠物元数据失败: HTTP ${metadataResp.status}`,
      };
    }

    onProgress?.(30, "正在解析宠物配置...");

    // 2. 解析 pet.json
    const definition = parsePetJson(metadataResp.body);
    if (!definition) {
      return { success: false, error: "宠物元数据格式无效。" };
    }

    onProgress?.(45, `正在下载精灵图: ${definition.name}...`);

    // 3. 下载 spritesheet 到临时路径
    //    从 URL 推断文件扩展名（.webp 或 .png）
    const home = await tauriInvoke("get_default_cwd");
    const sep = home.includes("/") && !home.includes("\\") ? "/" : "\\";
    const tempDir = `${home}${sep}.codem${sep}pets${sep}.tmp`;
    const spriteExt = pet.spritesheetUrl.match(/\.(webp|png)$/i)?.[1]?.toLowerCase() || "png";
    const tempSpritesheetPath = `${tempDir}${sep}${pet.slug}-spritesheet.${spriteExt}`;

    try {
      await httpDownload(pet.spritesheetUrl, tempSpritesheetPath, PETDEX_REFERER_HEADERS);
    } catch (err: any) {
      return {
        success: false,
        error: `下载精灵图失败: ${err.message || String(err)}`,
      };
    }

    onProgress?.(70, "正在读取精灵图数据...");

    // 4. 读取下载的精灵图为 Base64
    let spritesheetBase64: string;
    try {
      const { invoke } = (window as any).__TAURI__?.core || {};
      spritesheetBase64 = await invoke("read_file", { path: tempSpritesheetPath, encoding: "base64" });
    } catch (err: any) {
      return {
        success: false,
        error: `读取精灵图失败: ${err.message || String(err)}`,
      };
    }

    // 清理临时文件
    try {
      await (await import("../file-api")).deletePath(tempSpritesheetPath);
    } catch {
      // Ignore cleanup errors
    }

    onProgress?.(85, "正在安装宠物...");

    // 5. 安装到本地
    const result = await installPet(definition, spritesheetBase64, overwrite);
    if (!result.success) {
      return result;
    }

    onProgress?.(100, `宠物 "${definition.name}" 安装成功！`);

    return { success: true, slug: definition.slug };
  } catch (err: any) {
    return {
      success: false,
      error: `安装市场宠物失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 检查市场宠物是否已安装。
 */
export function isMarketPetInstalled(pet: MarketPet): boolean {
  return isPetInstalled(pet.slug);
}

/**
 * 通过 Rust 代理获取图片并返回 data URL。
 * 
 * 用于 R2 资产需要 Referer 头的场景：
 * 1. http_download 下载图片到临时文件（带 Referer 头）
 * 2. read_file 读取为 base64
 * 3. 拼接成 data URL 返回
 * 4. 删除临时文件
 * 
 * @param url 图片 URL
 * @param mimeType MIME 类型（如 "image/webp", "image/png"）
 * @returns data URL 或 null（失败时）
 */
export async function fetchPetImageAsDataUrl(
  url: string,
  mimeType: string = "image/webp",
): Promise<string | null> {
  try {
    const home = await tauriInvoke("get_default_cwd");
    const sep = home.includes("/") && !home.includes("\\") ? "/" : "\\";
    const tempDir = `${home}${sep}.codem${sep}pets${sep}.tmp`;
    const ext = mimeType === "image/png" ? "png" : "webp";
    const tempPath = `${tempDir}${sep}preview-${Date.now()}.${ext}`;

    // 下载（带 Referer 头）
    await httpDownload(url, tempPath, PETDEX_REFERER_HEADERS);

    // 读取为 base64
    const { invoke } = (window as any).__TAURI__?.core || {};
    const base64: string = await invoke("read_file", { path: tempPath, encoding: "base64" });

    // 清理临时文件
    try {
      await (await import("../file-api")).deletePath(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    return `data:${mimeType};base64,${base64}`;
  } catch {
    return null;
  }
}
