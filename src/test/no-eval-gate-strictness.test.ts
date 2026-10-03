/**
 * 第 124 波：**"无 eval" 门禁的严格性判据**。
 *
 * ## 为什么这条判据非有不可
 *
 * 门禁（`tools/audit/no-eval.mjs`）的**唯一职责**就是"能抓住 eval 等价物"。
 * 而在一个干净的仓库里，"跑一遍显示 0 命中"**同时**符合两种截然不同的现实：
 *  · 真的没有 eval ✓；
 *  · 或者某种写法它**压根不认识** ✗。
 * 判据与实现都绿，缺口却一直在 —— 这正是本轮发现的实情：
 * 模式表里只有 `new Function(`，**调用形式 `Function("…")` 与字符串形式的定时器都没有**，
 * 而文件头注释还写着"`Function(` 直接构造" ✗（注释与实现不一致，门禁只照实现办事）。
 *
 * 所以这里**喂夹具**：每种 eval 等价物必须被抓住；每种"看着像但不是"必须放过。
 *
 * 变异自证：把 `Function( 构造（非 new）` 那条模式删掉 ⇒ NE-2 红；
 * 把 `\b` 边界去掉（改成 `Function\s*\(`）⇒ NE-3（`isFunction(` 不该命中）红。
 */
import { describe, it, expect } from "vitest";

import { findEvalUses } from "../../tools/audit/no-eval.mjs";

const labels = (src) => findEvalUses(src).map((h) => h.label);

describe("第 124 波：无 eval 门禁必须抓住全部等价物", () => {
  it("NE-1: `new Function(…)` 与 `eval(…)`（原来就有的两条）", () => {
    expect(labels('const f = new Function("a", "return a");')).toContain("new Function(");
    expect(labels("eval(\"1+1\");")).toContain("eval(");
    expect(labels("window.eval('x');")).toContain("window.eval(");
    expect(labels("globalThis.eval('x');")).toContain("globalThis.eval(");
  });

  it("NE-2: **调用形式** `Function(…)`（不加 new）与**字符串形式的定时器**也必须抓住", () => {
    expect(labels('const f = Function("a", "return a");'), "Function( 调用形式同样是 eval 等价物").toContain(
      "Function( 构造（非 new）",
    );
    expect(labels('setTimeout("doSomething()", 100);'), "字符串定时器在 CSP 下同样不可用").toContain(
      "字符串形式的定时器（等同 eval）",
    );
    expect(labels("setInterval('tick()', 50);")).toContain("字符串形式的定时器（等同 eval）");
  });

  it("NE-3 反向对照: 看着像但不是的写法**不许**命中（门禁不能靠误报凑数）", () => {
    expect(labels("if (isFunction(x)) { run(); }")).toEqual([]);
    expect(labels("const p = Function.prototype;")).toEqual([]);
    expect(labels("myFunction(1, 2);")).toEqual([]);
    expect(labels("class FunctionScope {}")).toEqual([]);
    expect(labels("const t = setTimeout(() => tick(), 100);"), "回调形式的定时器是正常的").toEqual([]);
  });

  it("NE-4: 注释与字符串里的字样不算（否则满仓的说明文字都会变成违规）", () => {
    expect(labels("// 我们用 new Function 迁移到沙箱\nevalAllowed();")).toEqual([]);
    expect(labels("/* eval('x') 只是文档里的示例 */")).toEqual([]);
    expect(labels('const doc = "new Function(evil)";')).toEqual([]);
  });
});
