/**
 * 设置键「读写对称」契约（第 61 波）。
 *
 * 为什么需要（真实事故，都是第 61 波排查死字段时发现的）：
 *   · `codem-display-mode` —— 设置页**只写不读**：对话显示模式看起来能设置，
 *     但重启后没人读回来，永远回到默认值（设置项存在、效果不落地）。
 *   · `codem-current-project-path` —— 代码**只读不写**：全项目没有任何写入方，
 *     所以 codegraph 的「索引检测」拿到的一直是空串，功能从没生效过。
 *   · `system-prompt-instructions` / `ui-language` —— 读取时多传了一个"默认值"参数
 *     （`getSetting` 只接受一个参数），而那个文件带 `@ts-nocheck`，类型检查没拦住。
 *
 * 因此这里做一次机械对账：**每个设置键都必须既有写入方、又有读取方**。
 * 真正的"只读旋钮"（例如留给手工/脚本配置的高级项）写进白名单并说明理由。
 *
 * 这个检测器本身也被 SKEY-0 自检 —— 第 61 波写第一版时，它连续误报了 12 个键，
 * 全是「仪器坏了」而不是「代码有病」：
 *   · 把 `key.startsWith("codem-")`、`addEventListener("codem-open-file")` 当成设置键；
 *   · 把读取别名 `settings(...)`（以 set 开头）当成写入；
 *   · 6 个模块各自声明的 `SETTINGS_KEY` 在全局 name→value 表里互相覆盖，6 个键并成 1 个；
 *   · 泛型组写得过宽，`getSettingJSON<Record<string, any>>(KEY, …)` 的匹配从类型名
 *     `Record` 起头、一路吃到下一行的键，把真正的调用点整个吞掉。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanText, constsFrom, stripComments } from "./helpers/settings-key-scan";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** 允许"只有一方"的键（每条都要有理由） */
const ALLOWLIST = new Map<string, string>([
  ["agentsMdMaxBytes", "高级旋钮：AGENTS.md 读取上限，供手工/脚本写入，默认 32KB 生效"],
  ["codem-figma-token", "第三方 token：当前**没有设置界面**（图工具会提示去设置里配，属于待补的缺口）"],
  ["system-prompt-instructions", "高级旋钮：系统提示词覆盖，运行期只读，供手工配置"],
  ["ui-language", "由语言切换的其它通道写入（codem-language），此处兼容读取"],
]);
// 说明：`codem-settings` 一度也在白名单里（当时误判成"只写不读"），
// 修好「同名常量跨文件串味」后它读写对称（读 22 / 写 11），于是从白名单移除 —— 能不自证就不要自证。

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "target", ".git", "test", "__snapshots__"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 常量名 → 键值，按文件隔离 + 全局兜底（检测器本体在 helpers/settings-key-scan.ts） */
function collectConsts(files: string[]) {
  const global = new Map<string, string>();
  const perFile = new Map<string, Map<string, string>>();
  for (const f of files) {
    const local = constsFrom(readFileSync(f, "utf8"));
    for (const [k, v] of local) global.set(k, v);
    perFile.set(f, local);
  }
  return { global, perFile };
}

function collectKeys(files: string[], consts: ReturnType<typeof collectConsts>) {
  const writes = new Map<string, string[]>();
  const reads = new Map<string, string[]>();
  let callSites = 0;
  for (const f of files) {
    const local = consts.perFile.get(f) ?? new Map<string, string>();
    for (const hit of scanText(readFileSync(f, "utf8"), local, consts.global)) {
      callSites++;
      const rel = `${relative(ROOT, f).replace(/\\/g, "/")}:${hit.line}`;
      const bucket = hit.isWrite ? writes : reads;
      if (!bucket.has(hit.key)) bucket.set(hit.key, []);
      bucket.get(hit.key)!.push(rel);
    }
  }
  return { writes, reads, callSites };
}

describe("设置键读写对称契约（第 61 波）", () => {
  const files = walk(SRC);
  const consts = collectConsts(files);
  const { writes, reads, callSites } = collectKeys(files, consts);
  const allKeys = [...new Set([...writes.keys(), ...reads.keys()])].sort();

  it("SKEY-0: 检测器自检 —— 真键要认出来，事件名/前缀判断/读取别名不能被误判", () => {
    const scan = (src: string) => scanText(src, constsFrom(src), new Map());

    // 单行对象类型字面量泛型（SkillManager.tsx:246 的真实写法）
    const objGeneric = scan(`
      const KEY = "codem-model-profiles";
      getSettingJSON<{ profiles: P[]; id: string } | null>(KEY, null);
      setSettingJSON(KEY, { profiles: [], id: "default" });
    `);
    expect(objGeneric.map((h) => `${h.key}:${h.isWrite ? "w" : "r"}`)).toEqual([
      "codem-model-profiles:r",
      "codem-model-profiles:w",
    ]);

    // 多行对象类型字面量泛型 —— 真身就是 model-profile.ts:131，换行不能把调用点吃掉
    const multiline = scan(`
      const KEY = "codem-model-profiles";
      const stored = getSettingJSON<{
        profiles: P[];
        activeProfileId: string;
      } | null>(KEY, null);
    `);
    expect(multiline.map((h) => `${h.key}:${h.isWrite ? "w" : "r"}`)).toEqual(["codem-model-profiles:r"]);

    // 泛型里带 Record<…>：真正的调用点不能被类型名吞掉
    const recordGeneric = scan(`getSettingJSON<Record<string, any>>('user-presets', {})`);
    expect(recordGeneric.map((h) => h.key)).toEqual(["user-presets"]);

    // 读取别名 settings(...) 是读，不是写（它只是以 set 开头）
    const alias = scan(`
      const settings = (globalThis as any).__codemSettings?.getSettingJSON;
      if (typeof settings === 'function') settings("codem-retry-config", null);
    `);
    expect(alias.map((h) => `${h.key}:${h.isWrite ? "w" : "r"}`)).toEqual(["codem-retry-config:r"]);

    // 事件名 / 前缀判断不是设置键
    expect(scan('window.addEventListener("codem-open-file", h);')).toEqual([]);
    expect(scan('window.dispatchEvent(new CustomEvent("codem-env-script-result", {}));')).toEqual([]);
    expect(scan('if (key && key.startsWith("mimo-cli-session-")) { }')).toEqual([]);
    expect(scan('key.startsWith("codem-")')).toEqual([]);

    // 同名常量跨文件不串味：本文件优先，全局只是兜底
    const fileA = constsFrom('const SETTINGS_KEY = "codem-computer-user";');
    const fileB = constsFrom('const SETTINGS_KEY = "codem-hooks-config";');
    const glob = new Map([["SETTINGS_KEY", "codem-computer-user"]]);
    expect(scanText("getSettingJSON<Partial<X>>(SETTINGS_KEY, {})", fileA, glob).map((h) => h.key)).toEqual([
      "codem-computer-user",
    ]);
    expect(scanText("getSettingJSON<Partial<X>>(SETTINGS_KEY, {})", fileB, glob).map((h) => h.key)).toEqual([
      "codem-hooks-config",
    ]);
  });

  it("SKEY-1: 扫到的键/调用点数量合理（防止 glob/正则写错导致「空集也通过」）", () => {
    expect(allKeys.length).toBeGreaterThanOrEqual(30);
    expect(writes.size).toBeGreaterThanOrEqual(20);
    expect(reads.size).toBeGreaterThanOrEqual(20);
    // 调用点计数保证白名单/泛型组没有把大多数取键调用误杀（否则「全绿」是假绿）
    expect(callSites).toBeGreaterThanOrEqual(150);
  });

  it("SKEY-2: 每个设置键都必须既有写入方、也有读取方（只写/只读的都是 bug 或需登记）", () => {
    const problems: string[] = [];
    for (const key of allKeys) {
      if (ALLOWLIST.has(key)) continue;
      const w = writes.get(key);
      const r = reads.get(key);
      if (w && !r) problems.push(`【只写不读】${key} —— 写在 ${w[0]}，但没人读回来（设置看起来能存、重启后不生效？）`);
      if (!w && r) problems.push(`【只读不写】${key} —— 读于 ${r[0]}，但全项目没有写入方（这个键永远是空/默认值）`);
    }
    expect(problems, `设置键读写不对称：\n${problems.join("\n")}`).toEqual([]);
  });

  it("SKEY-3: 白名单里登记过的键必须仍然存在（避免白名单长草）", () => {
    const stale = [...ALLOWLIST.keys()].filter((k) => !allKeys.includes(k));
    expect(stale, `这些键已经不存在了，请从白名单删掉：\n${stale.join("\n")}`).toEqual([]);
  });

  it("SKEY-4: 不允许再出现「多传默认值」的 getSetting 调用（getSetting 只接受一个参数）", () => {
    const offenders: string[] = [];
    for (const f of files) {
      stripComments(readFileSync(f, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          // getSetting("key", xxx) —— 第二个实参会被静默忽略（@ts-nocheck 文件里连类型错误都没有）
          if (/\bgetSetting\s*\(\s*["'][^"']+["']\s*,/.test(line)) {
            offenders.push(`${relative(ROOT, f).replace(/\\/g, "/")}:${i + 1}  ${line.trim().slice(0, 90)}`);
          }
        });
    }
    expect(offenders, `getSetting 只接受一个参数，多传的默认值会被忽略：\n${offenders.join("\n")}`).toEqual([]);
  });
});
