/**
 * 「回复被输出上限截断」的续写契约（第 68 波）。
 *
 * 用户报告：说"继续之前没完成的任务"之后，一轮就结束了 —— 控制台里只有
 * `[AgenticLoop] Single-response dedup: 0 tool calls in this response: []`，
 * 紧接着直接进入记忆抽取（`[extractMemories] Extracted 15 memories`），
 * 也就是**这一轮没有任何工具调用就直接收尾了**。
 *
 * 根因：`finish_reason === "length"`（达到单次输出上限、回复被截断）此前**只用于
 * 内容型工具的提示**，从不参与"要不要停"的判断 —— 于是"被截断的回复"（尤其是纯文本、
 * 没有工具调用的那种）被当成「写完了」，用户看到的就是「任务又中断了」。
 *
 * 现在的契约：
 *   · 截断 ⇒ 注入「从断点继续」的提示并**继续循环**（预算 3 次）；
 *   · 预算用完 ⇒ 明确停下 + 告诉用户该怎么办（分块写入 / 调大上限），而不是静默结束；
 *   · 结束原因必须能从循环状态里读到（provider 的 end 事件不向上游 yield）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const loop = () => read("src/core/llm/agentic-loop.ts");

describe("输出截断 ⇒ 自动续写（第 68 波）", () => {
  it("TRUNC-1: 结束原因进入循环状态（不再只是 executeIteration 的局部变量）", () => {
    const src = loop();
    // 状态字段 + 初始化 + 写入点
    expect(src).toMatch(/lastFinishReason: string;/);
    expect(src).toMatch(/lastFinishReason: "stop",/);
    expect(src).toMatch(/this\.state\.lastFinishReason = finishReason;/);
    // 主循环要读它（而不是本地变量）
    expect(src).toMatch(/if \(this\.state\.lastFinishReason === "length"\) \{/);
  });

  it("TRUNC-2: 截断时先**自动续写**（注入从断点继续的提示 + continue），而不是收尾", () => {
    const src = loop();
    const idx = src.indexOf('if (this.state.lastFinishReason === "length") {');
    expect(idx).toBeGreaterThan(-1);
    // 按标记取块（不要用固定长度：这个分支本身会随修复长大，固定窗口会把断言截断）
    const giveUpIdx = src.indexOf('phase: "give-up"', idx);
    expect(giveUpIdx, "应能找到 give-up 分支作为块尾").toBeGreaterThan(idx);
    const block = src.slice(idx, giveUpIdx);
    expect(block, "要有续写预算").toMatch(/MAX_TRUNCATED_CONTINUATIONS/);
    expect(block, "注入提示").toMatch(/从断点继续/);
    expect(block, "教它分块写入").toMatch(/append: true/);
    expect(block, "不要重复已写内容").toMatch(/不要重复/);
    expect(block, "要继续循环而不是返回").toMatch(/\bcontinue;/);
    // 必须排在正常 completed 停止之前
    const completedAt = src.indexOf('reason: "completed"');
    expect(idx, "截断分支必须在 completed 分支之前").toBeLessThan(completedAt);
  });

  it("TRUNC-3: 续写预算用完 → 明确停下并给出下一步（不静默结束）", () => {
    const src = loop();
    const idx = src.indexOf('phase: "give-up"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block, "告诉用户已停止").toMatch(/已连续/);
    expect(block, "给出两条出路").toMatch(/分块写入/);
    expect(block).toMatch(/maxTokens/);
    expect(block, "结构化停止原因").toMatch(/reason: "output_truncated"/);
  });

  it("TRUNC-4: 续写预算按轮次重置（否则第二次任务一开始就没额度了）", async () => {
    /**
     * ⚠️ 第 48 波两处修正 ✗→✓：
     *   ① 原来只取 `run()` 的**前 1600 字符** ✗（魔法数字 ⇒ 加几行注释就假红 ✗）；
     *   ② 更要命的 ✓：`toContain("this.truncatedContinuations = 0")` 会被**注释里引用同一串文字**
     *      满足 ✗ ⇒ **判据空洞** ✓ —— 实测：把 `run()` 里那行改成 `= 777;` 之后它**照样绿** ✗✗。
     * ⇒ 现在用 **TypeScript AST** 断言「`run()` 内存在一条赋值：左侧是 `this.truncatedContinuations`、
     *    右侧是数字字面量 `0`」✓ ⇒ 注释骗不过 ✓，长度也不再假设 ✓。
     */
    const ts = (await import("typescript")).default;
    const src = loop();
    const sf = ts.createSourceFile("agentic-loop.ts", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    let span: { start: number; end: number } | null = null;
    const visit = (n: any): void => {
      if (ts.isMethodDeclaration(n) && n.name && n.name.getText(sf) === "run") {
        span = { start: n.getStart(sf), end: n.end };
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(span, "必须能找到 run() 方法 ✓").not.toBeNull();

    const resets: number[] = [];
    const walk = (n: any): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        n.left.getText(sf) === "this.truncatedContinuations" &&
        ts.isNumericLiteral(n.right) &&
        n.right.getText(sf) === "0"
      ) {
        const pos = n.getStart(sf);
        if (pos >= span!.start && pos < span!.end) resets.push(pos);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect(resets.length, "★ run() 内必须**真有**一条 `this.truncatedContinuations = 0` 赋值（注释不算 ✗）").toBeGreaterThan(0);
  });

  it("TRUNC-5: 内容型工具在截断回复里**不许执行**（第 67 波的事后提示已换成第 70 波 fail closed）", () => {
    const src = loop();
    // 判据换了：从"跑过之后提示核对完整性"改成"执行之前一律拒绝"。
    // 行为证据在 `pi-p1-truncated-toolcall-not-executed.test.ts`（断言 handler 没被调用、磁盘没变）。
    expect(src).toMatch(/finishReason === "length"/);
    expect(src, "整批拒绝要走同一条结构化失败路径").toMatch(/buildTruncatedToolCallError/);
    expect(src, "拒绝也要落一条可统计的事件").toMatch(/recordLoopStop\(sessionId, "output_truncated"/);
    // 纵深防御：内容型工具在执行**之前**被拦下
    expect(src).toMatch(/finishReason === "length" && isContentBearingTool\(name\)/);
  });
});
