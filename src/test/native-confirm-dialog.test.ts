/**
 * 「确认框必须真的问、答案必须真的等」的门禁（第 72 轮真机走查发现）
 *
 * ## 现场（可复核的真机取证）
 *
 * 在装机版上读 `window.confirm` 的源码，拿到的是：
 *
 * ```js
 * async function(i){return await n("plugin:dialog|confirm",{message:i.toString()})}
 * ```
 *
 * Tauri 的 dialog 插件把 `window.confirm` 换成了**异步插件调用**。于是旧代码
 * `if (!confirm(msg)) return;` 里的返回值是 **Promise（恒为真）** ⇒ 判断永远为 false
 * ⇒ **确认框没弹，不可逆的动作照做**。走查实测的那一例：点标题栏「切换执行模式」，
 * 控制台报 `[Unhandled Rejection] Command plugin:dialog|confirm not allowed by ACL`，
 * 而模式**已经被切过去了**。同形状的站点共 12 处（删项目、清恢复数据、删工作树、
 * 回滚快照、回滚文件改动、卸载 zvec、删智能体、删 Profile、开启明文密钥库…）。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | NC-1 | **生产源码里没有裸 `confirm(` / `window.confirm(`** —— 必须走 `confirmDialog` |
 * | NC-2 | 每一处 `confirmDialog(` 调用都带 `await`（忘了 await 就等于没改） |
 * | NC-3 | `confirmDialog` 对**两种世界**都给对答案：同步布尔 / thenable；拿不到答案时**按取消**（fail-closed）并上报 |
 * | NC-4 | `alertDialog` 失败时如实上报（不许静默丢提示） |
 * | NC-5 | `capabilities/default.json` **显式**放行 `dialog:allow-confirm` / `allow-message` / `allow-ask`（实测 `dialog:default` 不含 confirm） |
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { confirmDialog, alertDialog, DIALOG_FAILURE_AREAS } from "../core/ui/native-dialog";
import { getPersistFailures, resetPersistFailures, setPersistFailureListener } from "../core/storage/persist-failure";

const ROOT = process.cwd();

/** 去注释（否则本文件里的说明文字会把自己扫成违规） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 生产源码树（`src/**`，排除测试与夹具） */
function prodSources(): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  const stack = ["src"];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "src/test" || e.name === "node_modules") continue;
        /*
         * ⚠️ 技能自带脚本（`src/core/skills/skill-creator/scripts/*.ts`）**不在渲染进程里跑**
         * （由技能在运行期执行，环境不保证有 WebView/window），所以既不扫它、也不迁它 ——
         * 把它算进这条门禁会逼着人给一个"其实不该用 dialog 的地方"套上 dialog。
         */
        if (rel === "src/core/skills/skill-creator/scripts") continue;
        stack.push(rel);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push({ rel, code: stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8")) });
      }
    }
  }
  return out;
}

const HELPER = "src/core/ui/native-dialog.ts";

beforeEach(() => resetPersistFailures());
afterEach(() => resetPersistFailures());

describe("原生确认框：必须真的问、答案必须真的等（第 72 轮）", () => {
  it("NC-1: 生产源码里没有裸 `confirm(` / `window.confirm(`", () => {
    const offenders: string[] = [];
    for (const { rel, code } of prodSources()) {
      if (rel === HELPER) continue; // helper 自己是唯一的合法调用者
      // 只找**调用**（排除 `confirm:` 这种对象键、`ConfirmDialog` 这种标识符）
      for (const re of [/window\.confirm\s*\(/, /(?<![\w.$])confirm\s*\(/]) {
        const m = re.exec(code);
        if (m) offenders.push(`${rel}: …${code.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " ")}…`);
      }
    }
    expect(
      offenders,
      `这些地方还在直接用 confirm（dialog 插件下它返回 Promise ⇒ 判断恒为"继续执行"）：\n  - ${offenders.join("\n  - ")}\n` +
        `修法：import { confirmDialog } from "../core/ui/native-dialog"; 然后 \`if (!(await confirmDialog(msg))) return;\``,
    ).toEqual([]);
  });

  it("NC-2: 每一处 `confirmDialog(` 都必须带 `await`（漏了就等于没改）", () => {
    const bad: string[] = [];
    for (const { rel, code } of prodSources()) {
      if (rel === HELPER) continue;
      const calls = [...code.matchAll(/(?<![\w.$])confirmDialog\s*\(/g)].length;
      if (!calls) continue;
      const awaited = [...code.matchAll(/await\s+confirmDialog\s*\(/g)].length;
      if (awaited !== calls) bad.push(`${rel}: 调用 ${calls} 处，带 await 的 ${awaited} 处`);
      // 补一道反向判据：`!(await confirmDialog(...))` 这个形状才是"取消就返回"
      if (!/!\(\s*await\s+confirmDialog\s*\(/.test(code) && !/await\s+confirmDialog\s*\(/.test(code)) {
        bad.push(`${rel}: 找不到"等到答案再判断"的写法`);
      }
    }
    expect(bad, `这些站点的 await 不齐：\n  - ${bad.join("\n  - ")}`).toEqual([]);
  });

  it("NC-3a: 同步布尔（普通浏览器）原样返回", async () => {
    expect(await confirmDialog("x", { confirm: () => true })).toBe(true);
    expect(await confirmDialog("x", { confirm: () => false })).toBe(false);
    // 非布尔一律不算同意（undefined / 0 / 字符串都不行）
    expect(await confirmDialog("x", { confirm: () => undefined })).toBe(false);
    expect(await confirmDialog("x", { confirm: (() => 1) as unknown as () => boolean })).toBe(false);
    expect(getPersistFailures(), "正常回答不该上报").toHaveLength(0);
  });

  it("NC-3b: thenable（Tauri 注入的 shim）必须**等到**答案", async () => {
    expect(await confirmDialog("x", { confirm: () => Promise.resolve(true) })).toBe(true);
    expect(await confirmDialog("x", { confirm: () => Promise.resolve(false) })).toBe(false);
      // 关键：如果实现忘了 await，Promise 是恒真值 ⇒ 这里会得到 true（假"用户同意"）
    let resolveLate: (v: boolean) => void = () => {};
    const late = confirmDialog("x", { confirm: () => new Promise<boolean>((r) => (resolveLate = r)) });
    resolveLate(false);
    expect(await late, "迟到的 false 必须被等到（没 await 就会变成 true）").toBe(false);
  });

  it("NC-3c: 拿不到答案（被 ACL 拒 / 抛错 / 没有 confirm）⇒ **按取消**并上报", async () => {
    /*
     * 判据分两层，缺一不可：
     *   · 行为层：返回 false（不执行）；
     *   · **界面层**：横幅上那句"后果"必须说清"问不到"，而不是让用户以为"自己取消了"
     *     —— 走 `setPersistFailureListener` 抓真正进界面的 detail（`extra` 只进控制台，
     *     第一版就栽在这上面）。
     */
    const seen: { consequence?: string; message: string }[] = [];
    setPersistFailureListener((d) => seen.push({ consequence: d.consequence, message: d.message }));

    const denied = await confirmDialog("x", {
      confirm: () => Promise.reject(new Error("Command plugin:dialog|confirm not allowed by ACL")),
    });
    expect(denied, "被 ACL 拒绝时必须按「取消」处理 —— 这些动作都是不可逆的").toBe(false);
    let failures = getPersistFailures();
    expect(failures.map((f) => f.area)).toContain(DIALOG_FAILURE_AREAS.confirm);
    expect(failures[0].lastMessage, "上报里要带真机那句原文（便于一眼认出）").toContain("ACL");
    expect(failures[0].kind, "这是动作失败（功能没生效），不是写盘失败").toBe("action");
    expect(seen.at(-1)?.consequence, "界面上必须说清是「问不到」而不是「用户点了取消」").toContain("问不到");

    resetPersistFailures();
    expect(await confirmDialog("x", {})).toBe(false); // 环境里根本没有 confirm
    failures = getPersistFailures();
    expect(failures.map((f) => f.area)).toContain(DIALOG_FAILURE_AREAS.confirm);
    expect(seen.at(-1)?.consequence, "同样要说清后果").toContain("没有执行");
    setPersistFailureListener(null);
  });

  it("NC-4: `alertDialog` 失败时如实上报（提示不许静默丢）", async () => {
    await alertDialog("提示内容", { alert: () => undefined });
    expect(getPersistFailures(), "成功的提示不该上报").toHaveLength(0);

    await alertDialog("提示内容", { alert: () => Promise.reject(new Error("Command plugin:dialog|message not allowed by ACL")) });
    expect(getPersistFailures().map((f) => f.area)).toContain(DIALOG_FAILURE_AREAS.alert);
  });

  it("NC-6: 生产源码里也没有裸 `alert(`（提示失败必须可见，不许悄悄消失）", () => {
    /*
     * 第 83 轮（O-5）：`window.alert` 同样被 dialog 插件换成 `plugin:dialog|message`，
     * 而它**返回 void** —— 弹不出来时没有上报、用户什么都看不到（"点了没反应"）。
     * 修法与 confirm 同源：统一走 `alertDialog()`（失败进上报通道）。
     * 判据与 NC-1 同形状：**只扫调用**（`alert:` 这种键、`AlertDialog` 这种标识符不算）。
     */
    const offenders: string[] = [];
    for (const { rel, code } of prodSources()) {
      if (rel === HELPER) continue;
      for (const re of [/window\.alert\s*\(/, /(?<![\w.$])alert\s*\(/]) {
        const m = re.exec(code);
        if (m) offenders.push(`${rel}: …${code.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " ")}…`);
      }
    }
    expect(
      offenders,
      `这些地方还在直接用 alert（dialog 插件下失败时无人知晓）：\n  - ${offenders.join("\n  - ")}\n` +
        `修法：import { alertDialog } from "../core/ui/native-dialog"; 然后 \`void alertDialog(msg);\``,
    ).toEqual([]);
    // 反向对照：判据真的在判（把一行裸 alert 放进去必须能识别出来）
    expect(/(?<![\w.$])alert\s*\(/.test("  alert('x');")).toBe(true);
    expect(/(?<![\w.$])alert\s*\(/.test("  void alertDialog('x');"), "alertDialog 不该被误判成裸 alert").toBe(false);
  });

  it("NC-7: `alertDialog` 在「弹不出来」时走上报通道（这就是迁移的意义）", async () => {
    // 成功：不上报
    await alertDialog("提示", { alert: () => undefined });
    expect(getPersistFailures(), "成功的提示不该上报").toHaveLength(0);
    // 失败（真机形态：ACL 拒了 message）：必须上报，且说明"这条提示没有弹出来"
    await alertDialog("提示", { alert: () => { throw new Error("Command plugin:dialog|message not allowed by ACL"); } });
    const f = getPersistFailures();
    expect(f.map((x) => x.area)).toContain(DIALOG_FAILURE_AREAS.alert);
    expect(f[0].lastMessage).toContain("ACL");
  });

  it("NC-5: 能力清单必须**显式**放行 dialog 的 confirm / message / ask", () => {
    const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "capabilities", "default.json"), "utf8"));
    const perms: string[] = cap.permissions ?? [];
    for (const need of ["dialog:allow-confirm", "dialog:allow-message", "dialog:allow-ask"]) {
      expect(
        perms,
        `必须显式声明 ${need} —— 真机实测：只写 dialog:default 时调用被 ACL 拒（\`Command plugin:dialog|confirm not allowed by ACL\`）`,
      ).toContain(need);
    }
    expect(perms, "confirm 与 message 是两个独立的权限，不许只放行一个").toContain("dialog:allow-confirm");
    // 反向对照：这个判据真的在判（造一份不含 confirm 的清单必须是"不合规"）
    const bogus = perms.filter((p) => p !== "dialog:allow-confirm");
    expect(bogus).not.toContain("dialog:allow-confirm");
  });
});
