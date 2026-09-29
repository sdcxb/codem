/**
 * **浏览器桩陷阱**门禁（第 122 轮）—— 「真机上恒 false，而测试全绿」这类缺陷的拦网。
 *
 * ## 事故（真机抓到，不是推理出来的）
 *
 * 我给「开启新对话（交接当前工作）」写的 `ui-handoff.ts` 里用
 * `import { existsSync } from "node:fs"` 来核实"这条路径真的在磁盘上吗"。
 *
 * - **Node / Vitest**：真 `fs`，工作得很好，8 条用例全绿；
 * - **装机版**：`vite.config.ts:77` 把 `node:fs` alias 到
 *   `src/stubs/node-fs-stub.ts`，而那文件第 3 行是
 *   `export const existsSync = (_path: string): boolean => false` —— **恒返回 false**。
 *
 * 后果：`verifiedPaths` 永远为空 ⇒ `primaryPath` 永远为 null ⇒ 交接正文永远没有
 * 绝对路径 ⇒ 协议校验永远拒绝 ⇒ **这个按钮在真机上完全不可用**，而测试一个都不红。
 *
 * 真机诊断印出来的原文（提示条上）把它钉死了：
 * ```
 * ［cwd="C:\Users\abee\AppData\Roaming\com.codem.app\workspace\" home="" homeExists=false effective=null］
 * ```
 * cwd 明明是**真实存在**的目录，`existsSync` 却说它不存在；`homeExists` 是 `false`
 * 而不是 `"THREW"` ⇒ 它在正常返回，只是永远返回 false。
 *
 * ## 这个文件守什么
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | STUB-1 | 桩的**语义必须如实**：恒 false 的 `existsSync` 不是"路径不存在"，是"不知道" |
 * | STUB-2 | 生产代码里**不许**在需要"真的问磁盘"的地方用 `node:fs` 的检查函数（要注入） |
 * | STUB-3 | `ui-handoff` 的检查器**必须可注入**，且生产调用点传的是运行时实现 |
 * | STUB-4 | `buildHandover` 真的会用注入的检查器（**不是**摆设） |
 *
 * 最后一条是最重要的：STUB-1..3 都只能证明"接线形态对"，只有 STUB-4 能证明
 * "注入的东西真的被用了" —— 否则又是一个"建了没人用"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildHandover } from "../core/session/ui-handoff";

describe("第 122 轮 · 浏览器桩陷阱", () => {
  it("STUB-1: `node-fs-stub` 里那些「恒返回空」的函数必须**自己在注释里说明**", () => {
    /**
     * 桩本身**不必**改成抛错：`existsSync → false` 是 `fs` 的既有契约
     * （"不存在"与"无法访问"本来就都返回 false），改语义的风险比收益大。
     * 但"恒返回 false"这件事必须**写在文件里**，否则下一个人（包括我自己）会
     * 理所当然地以为它在问磁盘 —— 我已经这么栽过一次。
     */
    const stub = readFileSync("src/stubs/node-fs-stub.ts", "utf8");
    expect(stub, "桩文件必须存在").toContain("existsSync");
    expect(
      stub,
      "桩文件必须写明「这些函数在浏览器里不真的访问磁盘」——否则会被当成真 fs 用",
    ).toMatch(/恒|总是|不会真的|浏览器|invoke|IPC|不可用/);
  });

  it("STUB-2: 生产代码里不许直接拿 `node:fs` 的检查函数去判断「磁盘上有没有」", () => {
    /**
     * 这条是**结构判据**：`src/core` 与 `src/components` 下的生产文件
     * 只要 import 了 `node:fs` 的 `existsSync`/`statSync`/`readdirSync`，
     * 就等于"在浏览器里问一个不会回答的人"。需要这类能力时必须走
     * `core/file-api.ts`（Tauri IPC）或在运行时注入。
     *
     * 例外：Node-only 的 provider / 脚本（它们从不进浏览器 bundle）。
     */
    const allowNodeFs = [
      "src/core/skills/", // 技能脚本（Node 侧执行）
      "src/stubs/", // 桩自己
    ];
    const files = [
      "src/core/session/ui-handoff.ts",
      "src/components/WaterLevelBanner.tsx",
    ];
    for (const f of files) {
      if (allowNodeFs.some((a) => f.startsWith(a))) continue;
      const src = readFileSync(f, "utf8");
      /**
       * ⚠️ 判据必须**只认真正的 import 语句**，不能认注释里提到的符号。
       * 第一版用 `/from "node:fs"[^;]*\b(existsSync|…)\b/` 之类，结果把**说明性注释**
       * （文件头写着"第一版用过 `existsSync`，那是桩"）也算了进去 ⇒ 假红。
       * 现在是"逐行看：这一行是 import 且来自 node:fs 且引入了这三个函数之一"。
       */
      const offending = src.split(/\r?\n/).filter((line) => {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return false; // 注释不算
        if (!/^import\b/.test(t) && !/require\(/.test(t)) return false;
        if (!/["']node:fs["']/.test(t)) return false;
        return /\b(existsSync|statSync|readdirSync|readFileSync|writeFileSync)\b/.test(t);
      });
      expect(
        offending,
        `${f} 直接用了 node:fs 的文件函数 —— 浏览器里那是恒返回 false 的桩。` +
          `请改用 core/file-api.ts 的能力，或让调用方注入检查器（见 ui-handoff.ts 的 ExistsChecker）。`,
      ).toEqual([]);
    }
  });

  it("STUB-3: `buildHandover` 的存在性检查**可注入**，且生产调用点传的是运行时实现", () => {
    const handoffSrc = readFileSync("src/core/session/ui-handoff.ts", "utf8");
    // ① 契约里有**必填**的检查器（没有默认值 —— 生产代码不该有机会"忘了传"而拿到一个不会回答的实现）
    expect(handoffSrc).toContain("export type ExistsChecker");
    expect(handoffSrc, "检查器必须是必填（不许有默认值，默认值就是那个恒 false 的桩）").toMatch(
      /exists:\s*ExistsChecker/,
    );
    expect(handoffSrc, "不许再出现 `exists?`（可选就有默认值）").not.toMatch(/exists\?:\s*ExistsChecker/);
    // ② 真正的核实走的是注入的那个（不是 node:fs）
    expect(handoffSrc).toMatch(/await exists\(/);
    // ③ 生产调用点必须传运行时实现（`file-api.exists` → Tauri IPC）
    const bannerSrc = readFileSync("src/components/WaterLevelBanner.tsx", "utf8");
    expect(bannerSrc, "banner 必须从 file-api 取 exists").toMatch(
      /import\s*\(\s*["']\.\.\/core\/file-api["']\s*\)/,
    );
    expect(bannerSrc, "banner 必须把 exists 传给 buildHandover").toMatch(/exists:\s*\(p\)\s*=>/);
  });

  it("STUB-4: 注入的检查器**真的被用**（不是摆设）—— 换一个只认某条路径的检查器，结论必须跟着变", async () => {
    const msgs = [
      { id: "u1", role: "user", content: "干活", timestamp: 1, status: "done" },
      {
        id: "a1",
        role: "assistant",
        content: "已写",
        timestamp: 2,
        status: "done",
        toolCalls: [
          { id: "tc1", tool: "write", args: { path: "D:\\proj\\产物.md", content: "x" }, result: "ok", status: "done" },
        ],
      },
    ] as never[];

    /**
     * 检查器 A：**什么都不存在** ⇒ 产物进不了「已完成产物」。
     * 这正是真机上那个桩的行为（恒 false），也正是功能不可用的原因。
     */
    const noneExists = await buildHandover(msgs, { cwd: "D:\\proj", exists: () => false });
    expect(noneExists.producedPaths).toEqual([]);
    expect(noneExists.body).not.toContain("D:\\proj\\产物.md：本会话中由工具写出");

    /** 检查器 B：**说它存在** ⇒ 必须出现在「已完成产物」里。 */
    const allExists = await buildHandover(msgs, { cwd: "D:\\proj", exists: () => true });
    expect(allExists.producedPaths).toContain("D:\\proj\\产物.md");
    expect(allExists.body).toContain("D:\\proj\\产物.md：本会话中由工具写出");
    // 而且完成判据会指向它（说明 primaryPath 也跟着检查器走）
    expect(allExists.primaryPath).toBe("D:\\proj\\产物.md");

    /** 检查器 C：只认工作目录 ⇒ 退路生效，完成判据仍可判定。 */
    const onlyCwd = await buildHandover(msgs, { cwd: "D:\\proj", exists: (p) => p === "D:\\proj" });
    expect(onlyCwd.producedPaths).toEqual([]);
    expect(onlyCwd.primaryPath).toBe("D:\\proj");
    expect(onlyCwd.check.ok, `退路下仍须合规：${onlyCwd.check.error ?? ""}`).toBe(true);
  });
});
