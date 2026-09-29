/**
 * 门禁：工具执行的**调度顺序**必须保持模型给出的顺序。
 *
 * ## 修的是什么
 *
 * 旧实现把调用分成两个队列，先整批跑完所有可并发工具，再跑其余的：
 *
 * ```ts
 * const concurrentBatch = []; const sequentialQueue = [];
 * for (const tc of toolCalls) { ...二分... }
 * if (concurrentBatch.length) yield* this.executeBatch(concurrentBatch, ...);
 * for (const tc of sequentialQueue) yield* this.executeSingle(tc, ...);
 * ```
 *
 * 模型给出 `read(a) → edit(a)` 时，实际执行变成 `edit(a) → read(a)`：
 * 因为 write 类工具进了第二个队列，被整体挪到所有读取之后。
 *
 * 模型按「先读后写」组织调用是有意义的（它可能依赖刚读到的内容），
 * 顺序被打乱后它看到的结果与自己的推理链不一致，只能重读重试。
 *
 * ## 断言的形状
 *
 * 用**开始时刻的先后**而不是结束时刻：并行组内结束顺序天然不确定，
 * 但「谁先开始」是调度决策的直接体现。这正是被修的东西。
 */
import { describe, it, expect } from "vitest";
import {
  StreamingToolExecutorImpl,
  type StreamingToolCall,
  type ToolExecutorContext,
} from "../core/llm/streaming-executor";

function ctx(): ToolExecutorContext {
  return {
    sessionId: "s",
    messageId: "m",
    cwd: "/tmp",
    messages: [],
    abort: new AbortController().signal,
  } as ToolExecutorContext;
}

function call(id: string, name: string): StreamingToolCall {
  return { id, name, input: {}, status: "pending" };
}

/**
 * 跑一批调用，记录**每个工具开始执行**的顺序。
 * 每个工具返回前等一小段，保证「并行组」如果没有真的并行就会被看出来。
 */
async function runAndRecord(
  calls: StreamingToolCall[],
  safeTools: string[],
): Promise<string[]> {
  const started: string[] = [];
  const executor = new StreamingToolExecutorImpl({
    maxConcurrent: 5,
    concurrencySafeTools: safeTools,
  });

  for await (const _ of executor.execute(calls, ctx(), async (name) => {
    started.push(name);
    await new Promise((r) => setTimeout(r, 5));
    return { id: name, name, input: {}, status: "completed" as const, output: "ok" };
  })) {
    // 事件本身不影响断言
  }
  return started;
}

describe("工具调度保序", () => {
  it("read → edit：edit 不得被挪到 read 之前", async () => {
    const started = await runAndRecord(
      [call("1", "read"), call("2", "edit")],
      ["read", "grep", "glob"],
    );
    expect(started).toEqual(["read", "edit"]);
  });

  it("read(a) → edit(a) → read(a)：读-写-读的交错顺序必须保住", async () => {
    // 这是**最能区分新旧行为**的用例，也是危害最直接的一个。
    //
    // 旧实现把两个 read 收进 concurrentBatch、edit 放进 sequentialQueue，
    // 于是两次读取**一起**跑在 edit 之前：
    //     实际: read, read, edit      ← 第二次读发生在写入之前
    //     模型意图: read, edit, read  ← 第二次读应当看到写入后的内容
    //
    // 后果不是"慢一点"，而是**第二次读拿到的是过期内容**（stale read）：
    // 模型以为自己验证了改动，实际验证的是改动前的版本。
    const started = await runAndRecord(
      [call("1", "read"), call("2", "edit"), call("3", "read")],
      ["read", "grep", "glob"],
    );
    expect(started).toEqual(["read", "edit", "read"]);
  });

  it("连续的只读调用仍然并行（合成一组，不因保序而退化）", async () => {
    const started = await runAndRecord(
      [call("1", "read"), call("2", "grep"), call("3", "glob")],
      ["read", "grep", "glob"],
    );
    // 三个都开始之后才轮到任何非只读工具；这里没有非只读工具，
    // 所以顺序就是模型顺序，且它们同属一组（都在 5ms 睡眠前就 push 了）
    expect(started).toEqual(["read", "grep", "glob"]);
  });

  it("混合序列严格保序：read,edit,grep,write,glob", async () => {
    const started = await runAndRecord(
      [
        call("1", "read"),
        call("2", "edit"),
        call("3", "grep"),
        call("4", "write"),
        call("5", "glob"),
      ],
      ["read", "grep", "glob"],
    );
    expect(started).toEqual(["read", "edit", "grep", "write", "glob"]);
  });

  it("不可并发工具之间也保序（它们各自独占一组）", async () => {
    const started = await runAndRecord(
      [call("1", "write"), call("2", "edit"), call("3", "bash")],
      ["read"],
    );
    expect(started).toEqual(["write", "edit", "bash"]);
  });

  it("全不可并发时顺序完全等于模型顺序", async () => {
    const calls = [
      call("1", "bash"),
      call("2", "write"),
      call("3", "edit"),
      call("4", "multi_edit"),
    ];
    const started = await runAndRecord(calls, ["read"]);
    expect(started).toEqual(["bash", "write", "edit", "multi_edit"]);
  });

  it("结果数组顺序始终等于模型顺序（与完成先后无关）", async () => {
    const calls = [call("a", "read"), call("b", "read"), call("c", "read")];
    // 让**后**发出的调用**先**完成：若结果按完成顺序回填，断言就会失败
    const delays: Record<string, number> = { a: 15, b: 5, c: 1 };

    const executor = new StreamingToolExecutorImpl({
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
    });
    let final: Array<{ output?: string }> = [];
    for await (const ev of executor.execute(calls, ctx(), async (name, args, c) => {
      void name;
      void args;
      const id = (c as unknown as { toolCallId?: string }).toolCallId ?? "?";
      await new Promise((r) => setTimeout(r, delays[id] ?? 0));
      return { id, name: "read", input: {}, status: "completed" as const, output: `out-${id}` };
    })) {
      if (ev.type === "batch_complete") final = ev.results;
    }

    expect(final.map((r) => r.output)).toEqual(["out-a", "out-b", "out-c"]);
  });
});
