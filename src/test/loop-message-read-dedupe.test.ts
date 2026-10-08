/**
 * 第 184 波（G7）：**同一轮里不许对消息列表做两次全量读**。
 *
 * ## 缺陷形态
 *
 * `buildMessages(sessionId)` 每次迭代都做一次全量 `listMessages`（内存镜像 merge + **全量排序** + map，
 * 见 `storage/message.ts:548-631`）；紧接着同一轮里 `checkHasDocumentAttachment(sessionId)`
 * （`agentic-loop.ts` 的 P4 分支，用来决定要不要暴露 `read_attachment`）**又做了一次全量读**。
 * 一轮两次，且每个迭代都发生 —— 纯重复工作。
 *
 * ## 判据（驱动真实循环，数**真实存储调用次数**）
 *
 * | # | 判据 |
 * | --- | --- |
 * | PERF-1 | 一个迭代里 `listMessages` 只被调一次（修复前是 2 次） |
 * | PERF-2 | 反向对照：`read_attachment` 的暴露判定**结果不许变**（文档附件 ⇒ true；图片/无 ⇒ false） |
 * | PERF-3 | 复用只在**同一轮**生效：下一轮必须重新读（不许拿陈旧消息） |
 *
 * ## 手法说明
 *
 * **不 mock 整个 `storage/message` 模块**（它的具名导出很多，mock 少一个就报
 * `No "xxx" export is defined on the mock`，越补越偏）。这里只 `vi.spyOn` **那一个单例方法**，
 * 计数 + 控制返回值 —— 其余模块行为保持真实。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
// 循环用的是**命名空间导入**（`import * as MessageStorage`），所以 spy 要打在这个命名空间上
import * as MessageStorage from "../core/storage/message";

const SESSION = "test-perf-dedupe";
const CWD = "C:\\perf-dedupe";

const listMessagesCalls: string[] = [];
let storedMessages: any[] = [];
let spy: ReturnType<typeof vi.spyOn> | null = null;

class ScriptedProvider {
  id = "perf-provider";
  name = "Perf Mock";
  isConfigured() {
    return true;
  }
  async listModels() {
    return [];
  }
  async *stream() {
    yield { type: "text_delta", text: "好" };
    yield { type: "end", finishReason: "stop" };
  }
}

async function driveOneTurn(sessionId: string, messages: any[]) {
  storedMessages = messages;
  listMessagesCalls.length = 0;
  const loop = new AgenticLoop(new ScriptedProvider() as any, createDefaultToolRegistry(), {
    maxIterations: 1,
    model: "perf-model",
    securityMode: "full",
  });
  const events: any[] = [];
  for await (const e of loop.run(sessionId, "你好", CWD, "system")) events.push(e);
  return events;
}

describe("第 184 波 · 每轮消息读取去重（G7）", () => {
  beforeEach(() => {
    listMessagesCalls.length = 0;
    const storage: any = MessageStorage;
    spy = vi.spyOn(storage, "listMessages").mockImplementation((sid: string) => {
      listMessagesCalls.push(sid);
      return storedMessages;
    });
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  it("PERF-1: 一个迭代里消息列表只被全量读一次（修复前是两次）", async () => {
    await driveOneTurn(SESSION, [{ id: "m1", role: "user", content: "你好", timestamp: 1, hidden: false }]);
    const forSession = listMessagesCalls.filter((s) => s === SESSION);
    expect(
      forSession.length,
      `同一轮里全量 listMessages 调了 ${forSession.length} 次 —— ` +
        `buildMessages 与 checkHasDocumentAttachment 各读一次是重复工作（本波修的就是它）`,
    ).toBe(1);
  });

  it("PERF-2 反向对照：附件判定结果不变（文档附件 ⇒ true；图片/无 ⇒ false）", () => {
    const loop: any = new AgenticLoop(new ScriptedProvider() as any, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "perf-model",
      securityMode: "full",
    });

    storedMessages = [{ id: "m1", role: "user", content: "你好", timestamp: 1, hidden: false }];
    expect(loop.checkHasDocumentAttachment(SESSION), "没有附件 ⇒ false（read_attachment 被隐藏）").toBe(false);

    storedMessages = [
      {
        id: "m2",
        role: "user",
        content: "看这个文件",
        timestamp: 2,
        hidden: false,
        attachments: [{ type: "file", name: "a.ts" }],
      },
    ];
    expect(loop.checkHasDocumentAttachment(SESSION), "有文档附件 ⇒ true（read_attachment 暴露）").toBe(true);

    storedMessages = [
      {
        id: "m3",
        role: "user",
        content: "看这张图",
        timestamp: 3,
        hidden: false,
        attachments: [{ type: "image", name: "a.png" }],
      },
    ];
    expect(loop.checkHasDocumentAttachment(SESSION), "图片不算文档附件（既有语义不许变）").toBe(false);
  });

  it("PERF-3: 复用只在**同一轮**生效 —— 下一轮必须重新读（不许吃陈旧消息）", async () => {
    await driveOneTurn(SESSION, [{ id: "m1", role: "user", content: "第一轮", timestamp: 1, hidden: false }]);
    const first = listMessagesCalls.filter((s) => s === SESSION).length;
    await driveOneTurn(SESSION, [
      { id: "m1", role: "user", content: "第一轮", timestamp: 1, hidden: false },
      { id: "m2", role: "assistant", content: "新消息", timestamp: 2, hidden: false },
    ]);
    const second = listMessagesCalls.filter((s) => s === SESSION).length;
    expect(first, "第一轮读一次").toBe(1);
    expect(second, "第二轮也必须读一次（缓存不许跨轮存活）").toBe(1);
  });
});
