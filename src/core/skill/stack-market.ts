/**
 * Stack 市场（2026-10-29）：**不造第二套市场**。
 *
 * 技能市场已经是真的（GitHub / ClawHub / Skills.sh / SkillHub，ZIP 下载 + 沙箱审计）；
 * 这里只补“包”这一层：`stacks/index.json` 描述一个包由哪些**已上架技能**组成，
 * 安装时逐个从真实技能市场解析并安装。索引本身是仓库里的静态 JSON（raw.githubusercontent
 * 提供 HTTPS），所以没有额外服务、也没有假 registry。
 *
 * 边界：
 * - 只解析**技能名**；包的 workflow 文本暂不安装（需要先定落到哪个目录、是否覆盖）；
 * - 索引缺项/技能不在市场 → 返回 missing，不猜替代品；
 * - 网络/解析失败 → 抛给调用方（调用方显示“市场不可用”），不静默返回空。
 */
import type { MarketSkill, MarketSearchResult } from "./skill-market-client";

/** 默认索引：仓库里的 stacks/index.json（真实 HTTPS，随 master 更新） */
export const STACK_INDEX_URL =
  "https://raw.githubusercontent.com/sdcxb/codem/master/stacks/index.json";

export interface StackIndexEntry {
  name: string;
  version: string;
  description?: string;
  skills: string[];
}

export interface StackInstallDeps {
  httpGet?: (url: string) => Promise<string>;
  listSkills?: () => Promise<MarketSearchResult>;
  installSkill?: (skill: MarketSkill) => Promise<{ success: boolean; error?: string }>;
}

export interface StackInstallResult {
  name: string;
  version: string;
  installed: string[];
  missing: string[];
  failed: Array<{ name: string; error: string }>;
}

async function defaultHttpGet(url: string): Promise<string> {
  const invoke = (globalThis as any).__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("stack market requires Tauri runtime");
  const res = await invoke("http_get", { url });
  if (typeof res === "string") return res;
  // Rust HttpResponse { status, body, headers }
  if (res && typeof res.body === "string") return res.body;
  throw new Error("http_get 返回形状不认识（缺 body）");
}

function validateEntry(raw: any): StackIndexEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const skills = Array.isArray(raw.skills) ? raw.skills.filter((s: any) => typeof s === "string" && s.trim()) : [];
  if (!name || !version || skills.length === 0) return null;
  return { name, version, description: typeof raw.description === "string" ? raw.description : undefined, skills };
}

/** 拉取并解析索引；返回去重后的合法条目（坏条目丢弃，不阻塞其它包） */
export async function fetchStackIndex(deps: StackInstallDeps = {}): Promise<StackIndexEntry[]> {
  const httpGet = deps.httpGet ?? defaultHttpGet;
  const body = await httpGet(STACK_INDEX_URL);
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`stack 索引不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  const rawList = Array.isArray(parsed?.stacks) ? parsed.stacks : [];
  const seen = new Set<string>();
  const out: StackIndexEntry[] = [];
  for (const raw of rawList) {
    const entry = validateEntry(raw);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

/**
 * 按名字安装一个 stack：技能逐个从**真实技能市场**解析并安装。
 * 返回每个技能的结局（installed/missing/failed），不因单个失败中断。
 */
export async function installStackFromMarket(
  name: string,
  deps: StackInstallDeps = {},
): Promise<StackInstallResult> {
  const httpGet = deps.httpGet ?? defaultHttpGet;
  const listSkills = deps.listSkills ?? (async () => {
    const { listMarketSkills } = await import("./skill-market-client");
    return listMarketSkills();
  });
  const installSkill = deps.installSkill ?? (async (skill: MarketSkill) => {
    const { installMarketSkill } = await import("./skill-market-client");
    const r = await installMarketSkill(skill);
    return { success: r.success, error: r.error };
  });

  const entries = await fetchStackIndex({ httpGet });
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`stack 不存在：${name}`);

  const market = await listSkills();
  const byName = new Map<string, MarketSkill>();
  for (const s of market.skills ?? []) {
    const key = s.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, s);
  }

  const result: StackInstallResult = {
    name: entry.name,
    version: entry.version,
    installed: [],
    missing: [],
    failed: [],
  };
  for (const skillName of entry.skills) {
    const skill = byName.get(skillName.toLowerCase());
    if (!skill) {
      result.missing.push(skillName);
      continue;
    }
    try {
      const r = await installSkill(skill);
      if (r.success) result.installed.push(skillName);
      else result.failed.push({ name: skillName, error: r.error ?? "安装失败" });
    } catch (e) {
      result.failed.push({ name: skillName, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
