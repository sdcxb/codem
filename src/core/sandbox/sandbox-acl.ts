/**
 * Process-Level Sandbox — 沙箱**开关 / 允许目录**判定（唯一实现）。
 *
 * 这里只保留仍然生效的三件事：
 * 1. 沙箱总开关（`codem-sandbox-enabled`）—— 读失败时沿用上次成功值（见下）；
 * 2. 额外允许目录（`codem-sandbox-allowed-dirs`）的规范化 / 存取 / 路径段比较；
 * 3. 路径规范化（反斜杠、`~` 展开）。
 *
 * 历史上的进程内 ACL（SandboxPolicy / SandboxGuard / 命令黑名单 / 环境变量过滤）
 * 从未被任何生产路径消费，已于第 16 轮删除；真实拦截在 `core/llm/tool-pipeline.ts`
 * 的管线守卫里（按工具契约 + 工作区/允许目录判定）。
 */

import { getSetting, setSetting, removeSetting } from "../storage/settings";
import { reportActionFailure } from "../storage/persist-failure";

/**
 * 沙箱模式的设置键 —— **必须与设置面板里的开关一致**
 * （`SettingsPanel.tsx` 的 "🔒 沙箱模式（限制写入范围到工作目录）" 写的就是这个键）。
 *
 * 第 87 波（接线修复）：这个开关此前是个"装饰品" —— 面板能勾、界面显示已开启，
 * 而 `AgenticLoop` 里传给工具管线的 `isSandboxEnabled` 是硬编码 `() => false`，
 * `SandboxGuard` 从来没有真正启用过。现在两处用同一个键。
 */
export const SANDBOX_SETTING_KEY = "codem-sandbox-enabled";

/**
 * 上一次**成功读到**的沙箱开关值（第 87 轮）。
 *
 * 为什么要有它：这是个**安全开关**，而 `getSetting` 读失败时原来的写法是"按关闭处理" ——
 * 也就是**用户明确打开的沙箱，在一次读失败之后会静默失效**（界面上的开关还显示"已开启"）。
 * 这与第 86 轮修的那个洞（`hasUncommittedChanges` 失败被当成"工作区干净"）是同一类：
 * **问不到 ≠ 用户关掉了**。
 *
 * 现在：读失败时优先沿用**上次成功读到的值**（sticky），并把这次失败**走上报通道**
 * （横幅可见），而不是只在控制台留一句 warn。没有任何历史值时仍按产品默认（关闭）处理，
 * 但同样如实上报 —— 用户至少知道"这个开关这次没被确认"。
 */
let lastKnownSandboxEnabled: boolean | null = null;

/**
 * 沙箱模式是否开启（默认关闭；与面板默认一致）。
 *
 * ⚠️ 读失败时**不再静默**：优先返回上次成功读到的值（有的话），并上报；
 * 没有历史值时返回 false，同样上报 —— 让"这次没能确认"变成用户可见的事实。
 */
export function isSandboxAclEnabled(): boolean {
  try {
    const enabled = getSetting(SANDBOX_SETTING_KEY) === "true";
    lastKnownSandboxEnabled = enabled;
    return enabled;
  } catch (e) {
    if (lastKnownSandboxEnabled !== null) {
      reportActionFailure(
        "sandbox.readSetting",
        e,
        `读取沙箱设置失败，已沿用上次成功读到的值（${lastKnownSandboxEnabled ? "开启" : "关闭"}）`,
      );
      return lastKnownSandboxEnabled;
    }
    reportActionFailure(
      "sandbox.readSetting",
      e,
      "读取沙箱设置失败，且没有历史值 —— 本次按「关闭」处理（界面上的开关不代表本次实际生效状态）",
    );
    return false;
  }
}

/** 用例用：清掉"上次成功读到"的记忆，避免用例之间互相影响 */
export function __resetSandboxSettingCache(): void {
  lastKnownSandboxEnabled = null;
}

/**
 * 写入沙箱模式开关。
 * @returns 是否真的写进了设置（false = 只在本次运行内生效，重启后回到旧值）
 */
export function setSandboxAclEnabled(enabled: boolean): boolean {
  try {
    if (enabled) setSetting(SANDBOX_SETTING_KEY, "true");
    else removeSetting(SANDBOX_SETTING_KEY);
    return true;
  } catch (e) {
    console.error("[Sandbox] 沙箱设置写入失败（仅本次运行内生效）：", e);
    return false;
  }
}


/** 用户主目录（正斜杠形式）；浏览器环境取不到时为 null */
function homeDir(): string | null {
  try {
    const home =
      (typeof process !== "undefined" && (process.env?.USERPROFILE || process.env?.HOME)) || "";
    return home ? home.replace(/\\/g, "/").replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * 规范化沙箱路径：反斜杠 → `/`，并把开头的 `~` 展开成真实主目录。
 *
 * 第 84 波：**输入路径和黑名单条目必须用同一套规范化**。只规范化一边的话，
 * `~/.ssh` 这种条目要么永远匹配不上真实路径（`C:/Users/x/.ssh/id_rsa`），
 * 要么只能匹配写字面量 `~` 的调用 —— 两种都不是我们要的。
 */
function normalizeSandboxPath(p: string): string {
  let out = String(p ?? "").replace(/\\/g, "/");
  const home = homeDir();
  if (home && (out === "~" || out.startsWith("~/"))) {
    out = home + out.slice(1);
  }
  return out;
}

// ========== 沙箱允许目录（白名单） ==========

/**
 * 沙箱允许目录（额外放行的绝对路径）设置键。
 *
 * ## 为什么需要（2026-10-18 用户现场）
 *
 * 交接正文里写的是绝对路径（`C:/mimo-gui/docs/ui-spec.md`），而新会话的工作区是
 * `D:\mimo` ⇒ 沙箱把这**一个**路径判成工作区外，新会话第一件事就卡住。
 * 只给"关闭沙箱"这一条出路太重（那会放开**所有**路径），所以允许用户把
 * **具体目录**加进白名单 —— 范围可控、可撤销。
 *
 * 存的是 JSON 字符串数组；读写都经过 `normalizeAllowedDir`（同一套规范化），
 * 比较时大小写不敏感（Windows）且**按路径段**判前缀（`C:/a` 不算 `C:/ab` 的父目录）。
 */
const SANDBOX_ALLOWED_DIRS_KEY = "codem-sandbox-allowed-dirs";

/** 规范化一个允许目录：反斜杠→`/`、展开 `~`、去掉尾部分隔符 */
export function normalizeAllowedDir(dir: string): string {
  return normalizeSandboxPath(dir).replace(/\/+$/, "");
}

/** 读取允许目录（坏数据/读失败都按"没有"处理，但不会静默改写成别的值） */
export function getSandboxAllowedDirs(): string[] {
  try {
    const raw = getSetting(SANDBOX_ALLOWED_DIRS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((d) => normalizeAllowedDir(String(d ?? ""))).filter(Boolean)));
  } catch {
    return [];
  }
}

/**
 * 判断路径是否落在**任一**允许目录内（路径段边界，大小写不敏感）。
 *
 * 纯函数（目录可注入）⇒ 判据可以直接测，不依赖存储与真实磁盘。
 */
export function isWithinAllowedDirs(
  target: string,
  dirs: readonly string[] = getSandboxAllowedDirs(),
): boolean {
  const t = normalizeAllowedDir(target).toLowerCase();
  if (!t) return false;
  for (const dir of dirs) {
    const d = normalizeAllowedDir(dir).toLowerCase();
    if (!d) continue;
    if (t === d) return true;
    if (t.startsWith(d + "/")) return true;
  }
  return false;
}

/**
 * 把目录加入白名单（去重、跳过空串）。
 *
 * @returns 实际新增的目录（已存在的不重复写、也不重复返回）
 */
export function addSandboxAllowedDirs(dirs: readonly string[]): string[] {
  const existing = getSandboxAllowedDirs();
  const known = new Set(existing.map((d) => d.toLowerCase()));
  const added: string[] = [];
  for (const raw of dirs) {
    const dir = normalizeAllowedDir(String(raw ?? ""));
    if (!dir || known.has(dir.toLowerCase())) continue;
    known.add(dir.toLowerCase());
    added.push(dir);
  }
  if (added.length > 0) {
    const next = [...existing, ...added];
    setSetting(SANDBOX_ALLOWED_DIRS_KEY, JSON.stringify(next));
  }
  return added;
}

/** 从白名单移除一个目录（大小写不敏感；移除不存在的目录是空操作） */
export function removeSandboxAllowedDir(dir: string): void {
  const target = normalizeAllowedDir(dir).toLowerCase();
  const next = getSandboxAllowedDirs().filter((d) => d.toLowerCase() !== target);
  setSetting(SANDBOX_ALLOWED_DIRS_KEY, JSON.stringify(next));
}
