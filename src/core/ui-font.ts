/**
 * ui-font — 全局字号缩放（D1：让设置页字号滑杆真正生效）
 *
 * 历史缺陷 ①：SettingsPanel 的字号滑杆只写入 codem-settings JSON，
 * 全仓无消费方把字号应用到 DOM —— UI 字号恒为静态令牌（13px 基准）。
 * 修复：引入 `--ui-font-scale` CSS 变量（styles.css :root，基准 13px → scale = fontSize/13），
 * styles.css 全部 --fs-* 刻度已改为 `calc(<px> * var(--ui-font-scale))`。
 *
 * 历史缺陷 ②（第 56 波修复，用户报「打开设置后主页文字突然变大、关了也不回退」）：
 *   - 启动路径**存在**（Sidebar 挂载时调 `applyStoredUiFont(getSetting)`），但它读的是**旧扁平键**
 *     `codem-font-size` —— 只有用户手动拖过字号滑杆才会写这个键，所以全新/未拖过的用户启动时
 *     回落到基准 13px（scale 1.0）；
 *   - 而设置页**打开时**应用的是另一个来源 `codem-settings.fontSize`，它的默认值是 **14**
 *     → 全站瞬间放大 14/13 ≈ 7.7%；
 *   - 变量写在 `<html>` 的行内样式上，关掉设置不会复原（本会话一直放大），重启又回到 13
 *     —— 于是表现为"奇怪的跳变"。
 *   根子在于**同一个设置存了两个键、两处各带一个不同的默认值**。
 *
 * 现在**单一来源**：`codem-settings.fontSize` 为权威（设置页滑杆显示并保存的就是它），
 * `codem-font-size` 仅作旧版本兼容回退；默认值统一为基准 13px（与 `--fs-*` 的缩放基准一致，故打开设置不再跳字）。
 * 应用时机：**数据库就绪后（App.tsx）** + 侧栏挂载时 + 设置页打开/改动时 —— 三处共用下面这个解析器。
 *
 * 第 45 轮（D-18）补上**一次性迁移**：上面那句"单一来源"此前只是注释里的愿望 ——
 * `resolveUiFontPx` 的优先级其实是**旧键优先**，所以任何"只改 codem-settings.fontSize"的路径
 * 都会被旧键顶掉。现在 `applyStoredUiFont()` 会先跑 `migrateLegacyFontKey()`：
 * 用同一个解析器算出用户实际看到的值 → 写回权威键 → 删掉旧键。此后库里只剩一个来源，
 * 而解析器本身的规则（以及 `ui-font-scale.test.ts` 的 UI-FONT-2）保持不变。
 */

import { getSetting, getSettingJSON, removeSetting, setSettingJSON } from "./storage/settings";

/** 缩放基准：--fs-* 刻度以 13px 为 1.0，故默认 UI 字号也是 13px */
const FONT_BASE_PX = 13;
export { FONT_BASE_PX };

/** 滑杆范围（与设置页的 min/max 保持一致） */
const FONT_MIN_PX = 10;
const FONT_MAX_PX = 20;

/** 权威来源：设置页写入的完整设置对象 */
const SETTINGS_KEY = "codem-settings";
/** 旧版本只写过这个扁平键；它**只由字号滑杆写入**，因此它的存在等价于「用户确实调过字号」 */
const LEGACY_FONT_KEY = "codem-font-size";
/**
 * 旧代码的默认字号。`defaultSettings.fontSize` 是 14，而保存任何设置时都会把整个设置对象
 * （含这个默认值）写进 `codem-settings` —— 于是「14」既可能是用户自己选的、也可能只是默认值。
 * 判定：只有当旧扁平键不存在（= 从没拖过滑杆）时，才把 14 当作"未设置"归一为基准 13，
 * 这样"从没动过字号"的用户看到的字号与修复前启动时一致（不再跳变）；
 * 反过来，用户一旦拖过滑杆（写了旧键），14 就是他明确的选择，照用。
 */
const LEGACY_DEFAULT_FONT_PX = 14;

function parsePx(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPx(px: number): number {
  if (!Number.isFinite(px)) return FONT_BASE_PX;
  return Math.min(FONT_MAX_PX, Math.max(FONT_MIN_PX, Math.round(px)));
}

/**
 * 纯函数形式的解析（便于单测）。优先级：
 *   ① 旧扁平键（只由滑杆写入 ⇒ 用户明确选择）→ ② 设置对象里的 fontSize（14 且无旧键视为未设置）
 *   → ③ 基准 13。任何异常输入都回落到基准，绝不产生 NaN/越界。
 */
export function resolveUiFontPx(input: { fontSize?: unknown; legacyRaw?: string | null }): number {
  const explicit = parsePx(input.legacyRaw);
  if (explicit !== null) return clampPx(explicit);

  const fromSettings = parsePx(input.fontSize);
  if (fromSettings === null) return FONT_BASE_PX;
  if (fromSettings === LEGACY_DEFAULT_FONT_PX) return FONT_BASE_PX; // 旧默认值 = 未设置
  return clampPx(fromSettings);
}

/** 从存储里解析生效字号（权威源 → 旧键 → 基准） */
export function readStoredUiFontPx(): number {
  try {
    const json = getSettingJSON<{ fontSize?: unknown } | null>(SETTINGS_KEY, null);
    return resolveUiFontPx({ fontSize: json?.fontSize, legacyRaw: getSetting(LEGACY_FONT_KEY) });
  } catch {
    return FONT_BASE_PX;
  }
}

/** 把字号 px 值写入 CSS 变量（13px 基准 → scale） */
export function applyUiFontScale(fontSizePx: number): void {
  try {
    const clamped = clampPx(fontSizePx);
    const scale = (clamped / FONT_BASE_PX).toFixed(3);
    document.documentElement.style.setProperty("--ui-font-scale", scale);
  } catch {
    /* non-DOM env — no-op */
  }
}

/**
 * 读取已存字号并应用（启动时与设置页共用同一个解析器 —— 这是不再跳变的关键）。
 * @returns 实际生效的 px 值
 */
export function applyStoredUiFont(): number {
  migrateLegacyFontKey();
  const px = readStoredUiFontPx();
  applyUiFontScale(px);
  return px;
}

// ========== 旧扁平键一次性迁移（第 45 轮 D-18）==========
//
// 本文件头写着"**单一来源**：`codem-settings.fontSize` 为权威"，但解析器
// （`resolveUiFontPx`）的优先级其实是**旧键优先** —— 于是任何"只改 codem-settings.fontSize"
// 的路径（导入、脚本、将来的设置同步）都会被旧键顶掉，且设置页每次打开都会被
// `applyStoredUiFont()` 把显示值拉回旧键。两个来源不同默认值的历史事故已经发生过一次
// （见文件头"历史缺陷 ②"），留着两份就是留着第二次。
//
// 修法按审计给的最小方案：**启动时一次性迁移**——算出一个"用户实际选择的值"，
// 写回权威键，然后**删掉旧键**。此后库里只剩一个来源，而 `resolveUiFontPx` 的规则
// （以及 `ui-font-scale.test.ts` 的 UI-FONT-2）完全不变 —— 迁移完旧键已不存在，
// 它的"旧键优先"分支再也走不到。
//
// 冲突时以谁为准（两个键值不同才会走到这里）：
// - **权威键是"非默认档"的显式值 ⇒ 权威键胜**。理由：旧扁平键只由滑杆写过，而滑杆在
//   现版本里**同时写两个键**（两键必然相等）。所以出现"权威键 ≠ 旧键且权威键非默认档"，
//   说明权威键这一侧是更新的一次写入（导入/脚本/将来的同步）——旧键才是残留。
//   这正是 D-18 的另一半：审计指出"任何只改 codem-settings.fontSize 的路径都会被忽略"。
// - 其余情况（权威键缺失、或恰好是两个历史默认档 13/14）⇒ **旧键胜**（= 现有解析器语义）。
//   理由同 `LEGACY_DEFAULT_FONT_PX` 的注释：默认档的值可能只是"保存设置时被一起写进去的
//   默认值"，而旧键的存在证明用户**真的拖过滑杆**，不能反被默认值顶掉。
//
// 两个刻意的边界：
// - **不再写旧键**：迁移后旧键从库里消失，`resolveUiFontPx` 只剩"权威键 → 基准"一条路；
// - **没有 codem-settings 时不迁移**：不为了一个字号凭空造一个设置对象（那个对象承载
//   mode/model/providers，凭空造出来会让"设置存在但字段缺失"变成新常态）。此时旧键
//   仍是唯一来源，行为与迁移前完全一致。
/** 两个"可能只是默认值"的字号档（当前基准 13 / 旧版本默认 14）——只有它们不算"显式选择" */
const DEFAULT_LIKE_PX: readonly number[] = [FONT_BASE_PX, LEGACY_DEFAULT_FONT_PX];

function migrateLegacyFontKey(): { migrated: boolean; px: number } | null {
  let legacyRaw: string | null = null;
  try {
    legacyRaw = getSetting(LEGACY_FONT_KEY);
  } catch {
    return null;
  }
  if (legacyRaw === null || legacyRaw === undefined || legacyRaw === "") return null;

  let settings: (Record<string, unknown> & { fontSize?: unknown }) | null = null;
  try {
    settings = getSettingJSON<Record<string, unknown> | null>(SETTINGS_KEY, null);
  } catch {
    settings = null;
  }
  // 权威对象不在 ⇒ 没有第二个来源可谈，保持原样（见上面第二条边界）
  if (!settings || typeof settings !== "object") return null;

  const fromSettings = parsePx(settings.fontSize);
  const authoritativeIsExplicit = fromSettings !== null && !DEFAULT_LIKE_PX.includes(clampPx(fromSettings));
  const px = authoritativeIsExplicit
    ? clampPx(fromSettings)
    : resolveUiFontPx({ fontSize: settings.fontSize, legacyRaw });

  try {
    setSettingJSON(SETTINGS_KEY, { ...settings, fontSize: px });
    removeSetting(LEGACY_FONT_KEY);
  } catch {
    // 迁移失败（端口不可用等）：**不删旧键**，下次启动再试 —— 绝不让"迁移没做成"变成"字号丢了"
    return null;
  }
  return { migrated: true, px };
}

// ========== 全局字体（D-3）==========
//
// 设置页的「全局字体」下拉此前把值写进 `--font-family`，而全项目**没有任何地方消费**
// `var(--font-family)`（它只是 `styles.css` 里 `--font-ui` 的兼容别名，供外部插件取用）：
// 于是"选字体"当场与重启后都没有任何变化 —— 最典型的一类死设置（读写都正确、就是没有生效点）。
// 真正的生效点是 `--font-ui`（`styles.css` 的 `body { font-family: var(--font-ui) }` 等 9 处）。

/** 默认字体档的选项值（设置页下拉的第一项） */
export const DEFAULT_FONT_FAMILY = "AlimamaFangYuanTi";
/** 设置键（旧版本就在用，保持不变以免丢用户选择） */
const FONT_FAMILY_KEY = "codem-font-family";

/** 读取已存的全局字体；没存过/存的是默认档 → 返回默认档选项值 */
export function readStoredUiFontFamily(): string {
  try {
    const stored = getSetting(FONT_FAMILY_KEY);
    return stored && stored.trim() !== "" ? stored : DEFAULT_FONT_FAMILY;
  } catch {
    return DEFAULT_FONT_FAMILY;
  }
}

/**
 * 应用全局字体。
 *
 * **默认档必须 `removeProperty("--font-ui")`**：选项值 `AlimamaFangYuanTi` 只是一个裸字体名，
 * 直接写进 `--font-ui` 会**整条覆盖** `styles.css` 里那条 fallback 栈
 * （`'AlimamaFangYuanTi', -apple-system, BlinkMacSystemFont, "Segoe UI", …`）——
 * 没装该字体的机器会退到浏览器默认字体，而不是设计好的备选链。
 * 删掉行内覆盖后，`--font-ui` 回到 `:root` 的令牌默认值（含完整 fallback 栈），
 * 这正是"默认档"该有的语义：**没有行内覆盖** ≠ "写了一个裸名字"。
 */
export function applyUiFontFamily(family: string | null | undefined): void {
  try {
    const value = (family ?? "").trim();
    const root = document.documentElement;
    if (value === "" || value === DEFAULT_FONT_FAMILY) {
      root.style.removeProperty("--font-ui");
      return;
    }
    root.style.setProperty("--font-ui", value);
  } catch {
    /* non-DOM env — no-op */
  }
}

/** 读取已存字体并应用（启动路径与设置页共用同一个入口） */
export function applyStoredUiFontFamily(): string {
  const family = readStoredUiFontFamily();
  applyUiFontFamily(family);
  return family;
}

