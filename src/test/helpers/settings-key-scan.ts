/**
 * 设置键扫描器（第 61 波）—— 给 `settings-keys-symmetry.test.ts` 与 `settings-effect.test.ts` 共用。
 *
 * 放在 `helpers/` 而不是某个 `.test.ts` 里：从测试文件 import 测试文件会把对方的 `describe`
 * 一起注册进来（本波踩过：`settings-effect.test.ts` 因此报"8 tests"而不是 3 个，且全量跑时重复计）。
 *
 * 这个扫描器**自己也有一组自检**（`SKEY-0`）。第 61 波写第一版时它连续误报了 12 个键，
 * 人工核对后**全部是仪器坏了、不是代码有病**：
 *   · 把 `key.startsWith("codem-")`、`addEventListener("codem-open-file")` 当成设置键；
 *   · 把读取别名 `settings(...)`（= `__codemSettings.getSettingJSON`，以 set 开头）当成写入；
 *   · 6 个模块各自声明的 `SETTINGS_KEY` 在全局「常量名→键值」表里互相覆盖，6 个键并成 1 个；
 *   · 泛型组写得过宽，`getSettingJSON<Record<string, any>>(KEY, …)` 的匹配从类型名 `Record`
 *     起头、跨行吃到下一行的键，把真正的调用点整个吞掉。
 * 所以：**没有自检的检测器，产出的"发现"不可信。**
 */

/**
 * 读/写设置键的函数名白名单。
 *
 * 必须是白名单而不是"以 set 开头就算写"：
 *   · `const settings = globalThis.__codemSettings?.getSettingJSON`（retry.ts:123）是**读**，
 *     但 `settings` 恰好以 `set` 开头 —— 早先的 `/^set/` 判定把这次读取记成了写入，
 *     于是 `codem-retry-config` 被误报成「只写不读」。
 *   · `key.startsWith("codem-")`、`window.addEventListener("codem-open-file")`、
 *     `new CustomEvent("codem-env-script-result")` 里的字符串是**事件名/前缀判断**，
 *     不是设置键；它们同样以 `codem-` 开头，靠函数名排除才干净。
 */
export const READ_FNS = new Set([
  "getSetting",
  "getSettingJSON",
  "getItem",
  "settings", // retry.ts 的读取别名（= __codemSettings.getSettingJSON）
]);
export const WRITE_FNS = new Set([
  "setSetting",
  "setSettingJSON",
  "removeSetting",
  "setItem",
  "removeItem",
  "saveSetting",
  "writeSetting",
  "updateSetting",
  "deleteSetting",
]);

export const KEY_PREFIX_RE =
  /^(codem-|apiKeys$|user-presets$|agentsMdMaxBytes$|plans-store$|system-prompt-instructions$|ui-language$|mimo-)/;

/** 剥注释：注释里解释 bug 的句子会把检查自己绊倒（本波踩过） */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * 取键正则：函数名 +（可选）泛型 + 左括号 + 第一个实参（字面量键或常量名）+ 逗号/右括号。
 *
 * 泛型组 `[^()=]*` 的约束被真实误报/漏报各逼过一次：
 *   · 不许 `(` `)` —— 否则 `Record<string, PeerEntry>` 这类写法无法回退到最后一个 `>`；
 *   · 不许 `=` —— 这是把「类型实参」和「代码」区分开的关键：坏匹配总是从类型名
 *     `Record` 起头、跨行吃到下一行的键（中间夹着 `=> {` 或 `const m = getSettingJSON(`），
 *     而 `=` 恰好只能出现在代码里，拦住它，匹配就不会跨过语句边界，
 *     真正的 `getSettingJSON(` 也不会被吞掉（user-presets、codem-wechat-peer-map 的误报源头）；
 *   · 允许换行、`{}` `;` `:` —— 多行对象类型字面量泛型是真实写法：
 *     `getSettingJSON<{\n  profiles: X[];\n  id: string;\n} | null>(KEY, null)`（model-profile.ts:131）。
 */
const CALL_RE = /([A-Za-z_$][\w$.]*)\s*(?:<[^()=]*>)?\s*\(\s*(?:["'`]([\w.-]+)["'`]|([A-Z][A-Z0-9_]*))\s*[,)]/g;

export type Hit = { fn: string; key: string; line: number; isWrite: boolean };

/**
 * 从一段代码里取出「设置键调用点」。local 是**本文件**的常量表，global 是全项目兜底：
 * 同名常量在不同模块里指向不同的键（`SETTINGS_KEY` 有 6 个不同取值），
 * 只看全局表会让后写覆盖先写、6 个键并成 1 个。
 */
export function scanText(rawText: string, local: Map<string, string>, global: Map<string, string>): Hit[] {
  const text = stripComments(rawText);
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(text)) !== null) {
    const fn = m[1].split(".").pop() ?? m[1];
    const isWrite = WRITE_FNS.has(fn);
    if (!isWrite && !READ_FNS.has(fn)) continue; // 事件名、startsWith、自定义包装函数 —— 不是设置键
    const key = m[2] ?? local.get(m[3] ?? "") ?? global.get(m[3] ?? "");
    if (!key) continue;
    if (!KEY_PREFIX_RE.test(key)) continue;
    if (/[-.]$/.test(key)) continue; // 前缀片段，例如 key.startsWith("mimo-cli-session-")
    hits.push({ fn, key, line: text.slice(0, m.index).split("\n").length, isWrite });
  }
  return hits;
}

/** 从一段代码里收集常量声明（`const FOO_BAR = "codem-foo"`） */
export function constsFrom(src: string): Map<string, string> {
  const local = new Map<string, string>();
  for (const m of stripComments(src).matchAll(
    /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*["']([\w.-]+)["']/g,
  )) {
    local.set(m[1], m[2]);
  }
  return local;
}
