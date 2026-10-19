/**
 * ARGSFOLD：旧**工具参数**的折叠（2026-10-19）。
 *
 * 真机：用户另一台电脑 25 万 token 的会话里，`write` 的参数占 **98K token**（整份文件正文）。
 * 折叠工具结果救不了它（它不是"结果"），但旧调用只留 `path`、把正文换成"可用 read 重读"的标记，
 * 就能把这 98K 拿回来——很多会话因此不必压缩。
 *
 * 边界：只对 `write`/`edit`/`multi_edit`；最近 2 次调用不动；只读视图（入参不改）。
 * 判据 `ARGSFOLD-1..4`；变异 `fold-tool-args`。
 */
import { describe, it, expect } from "vitest";
import {
  ARGS_FOLD_MIN_CHARS,
  FOLDABLE_ARGS_TOOLS,
  foldToolOutputsUnderTarget,
} from "../core/llm/tool-output-fold";
import { estimateRawContextTokens } from "../core/llm/compaction-budget";

const WINDOW = 128_000;
const AVAILABLE = Math.round(WINDOW * 0.9);
const estimate = (ms: any[]) => estimateRawContextTokens(ms);

function writeCall(id: string, path: string, chars: number) {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [{ tool: "write", args: { path, content: "字".repeat(chars) }, result: "ok" }],
  };
}
function user(id: string) {
  return { id, role: "user", content: "继续" };
}

describe("ARGSFOLD 旧工具参数折叠", () => {
  it("ARGSFOLD-1: 旧的 write 参数只留 path，正文换成可重读标记；最近 2 次不动", () => {
    const msgs: any[] = [user("u0")];
    for (let i = 0; i < 20; i++) msgs.push(writeCall(`w${i}`, `src/f${i}.ts`, 20_000));
    msgs.push({ id: "final", role: "assistant", content: "完成" });

    const before = estimate(msgs) / AVAILABLE;
    expect(before, "构造场景必须真的超预算").toBeGreaterThan(0.7);

    const result = foldToolOutputsUnderTarget(msgs, {
      protectedFromIndex: 0,
      targetTokens: Math.floor(AVAILABLE * 0.45),
      estimate,
    });
    const after = estimate(result.messages) / AVAILABLE;
    expect(after, `折完参数后应明显下降（实际 ${(after * 100).toFixed(0)}%）`).toBeLessThan(0.7);

    const first = result.messages.find((m: any) => m.id === "w0")!.toolCalls[0];
    expect(first.args.path, "path 必须保留").toBe("src/f0.ts");
    expect(first.args.content, "正文换成标记").toContain("已折叠");
    expect(first.args.content, "标记里说明可重读").toContain("read");

    // 最近 2 次工具调用逐字不动
    const lastTwo = msgs.slice(-3, -1).map((m) => m.toolCalls?.[0]?.args?.content);
    const newLastTwo = result.messages.slice(-3, -1).map((m) => m.toolCalls?.[0]?.args?.content);
    expect(newLastTwo).toEqual(lastTwo);
    expect(result.messages).toHaveLength(msgs.length);
  });

  it("ARGSFOLD-2: 不落盘的工具（bash）与短参数不参与", () => {
    expect(FOLDABLE_ARGS_TOOLS.has("bash")).toBe(false);
    const msgs: any[] = [
      user("u0"),
      { id: "b1", role: "assistant", content: "", toolCalls: [{ tool: "bash", args: { command: "字".repeat(20_000) }, result: "ok" }] },
      { id: "w1", role: "assistant", content: "", toolCalls: [{ tool: "write", args: { path: "a", content: "x".repeat(ARGS_FOLD_MIN_CHARS - 1) }, result: "ok" }] },
      { id: "x", role: "assistant", content: "完成" },
    ];
    const result = foldToolOutputsUnderTarget(msgs, {
      protectedFromIndex: 0,
      targetTokens: 1,
      estimate,
    });
    const bash = result.messages.find((m: any) => m.id === "b1")!.toolCalls[0];
    expect(bash.args.command).toHaveLength(20_000);
    const w = result.messages.find((m: any) => m.id === "w1")!.toolCalls[0];
    expect(w.args.content).toHaveLength(ARGS_FOLD_MIN_CHARS - 1);
  });

  it("ARGSFOLD-3: 只读视图 —— 入参一字不动", () => {
    const msgs: any[] = [user("u0")];
    for (let i = 0; i < 10; i++) msgs.push(writeCall(`w${i}`, `f${i}`, 20_000));
    const snapshot = JSON.stringify(msgs);
    foldToolOutputsUnderTarget(msgs, { protectedFromIndex: 0, targetTokens: 1, estimate });
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("ARGSFOLD-4: 参数折叠后 JSON 仍然可序列化（tool-call 协议不坏）", () => {
    const msgs: any[] = [user("u0")];
    for (let i = 0; i < 6; i++) msgs.push(writeCall(`w${i}`, `f${i}`, 30_000));
    const result = foldToolOutputsUnderTarget(msgs, { protectedFromIndex: 0, targetTokens: 1, estimate });
    for (const m of result.messages) {
      for (const tc of m.toolCalls ?? []) {
        expect(() => JSON.stringify(tc.args)).not.toThrow();
        expect(typeof tc.args.path).toBe("string");
      }
    }
  });
});
