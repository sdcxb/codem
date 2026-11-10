/**
 * WS-9：**显式开启**（`segmentEpochs:true`）下的短历史零变化；默认 false 由 DEF-1 守。
 *
 * ## 为什么单开一个文件
 *
 * `working-set.test.ts` 里的真循环用例（WS-5 / WS-7 / WS-8）都在 `beforeEach` 里
 * 显式写 `segmentEpochs: false` —— 那是为了拿旧路径当**对照臂**（先证明工作集在旧闸门下
 * 不动，再证明超预算时它才动）。于是「**不写任何 settings、直接用默认配置跑**」这个形态
 * 在那一个文件里结构上造不出来：它要么继承显式关闭，要么依赖同文件其它用例的清理顺序。
 *
 * 本文件**一处 `updateConfig` 都不调**：`segmentEpochs` 取 `DEFAULT_CONFIG` 的 true
 * （2026-11-08 锁定默认 false；本用例显式开启）。这样 WS-9 钉住的是**显式开启后的工作集路径**：
 * 默认开启 + 短历史（远小于预算）⇒ 请求逐字节与改前一致、清单里没有工作集字段。
 *
 * ## 判据
 *
 * | 断言 | 变红方式 |
 * |---|---|
 * | 请求里没有 `# 更早消息索引` 头 | 把闸门改成「无条件生成索引」⇒ 短历史也出现索引 |
 * | 对话消息的 id / 顺序 / 正文与库里三条一致 | 工作集顺手重排 / 复制出重复消息 |
 * | `manifest.workingSet === undefined` | 没走工作集却把 0 记成「走过」 |
 *
 * 与并发、时钟无关：单会话、单回合、固定 `maxIterations: 1`，provider 是记录型假实现，
 * 断言只看这一次请求与这一次落下的清单。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { WORKING_SET_INDEX_HEADER } from "../core/context/working-set";

const SESSION = "ws-default-on";
const SYSTEM_PROMPT = "你是工作集默认开启判据用的助手。";

class RecordingProvider {
  id = "ws-default-on-provider";
  name = "WS Default-On Mock";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 库里的三条短历史（远小于预算；ASCII 正文让 token 估算不受中文 BPE 启发式影响） */
const HISTORY_ROWS = [
  { id: "def-1", session_id: SESSION, role: "user", content: "你好", timestamp: 1, status: "done", hidden: 0 },
  { id: "def-2", session_id: SESSION, role: "assistant", content: "在", timestamp: 2, status: "done", hidden: 0 },
  { id: "def-3", session_id: SESSION, role: "user", content: "第二轮", timestamp: 3, status: "done", hidden: 0 },
];

describe("C03 工作集：默认配置下短历史零变化（WS-9）", () => {
  let port: any;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { setStoragePort } = await import("../core/storage/port");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    const { forgetManifests } = await import("../core/context/manifest");

    forgetManifests(SESSION);
    getTokenTracker().setContextWindow(200_000);
    /**
     * ★ 刻意**不**调用 `getContextManager().updateConfig(...)`、也不往 settings 写任何键：
     * `segmentEpochs` 必须来自 `DEFAULT_CONFIG`（true）。写了就退回 WS-5 的对照臂形态，
     * 本判据测的是显式开启路径。
     */
    port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION, project_id: "p1", title: "t", created_at: 1, last_message_at: 3, message_count: 3 },
        ],
        messages: HISTORY_ROWS.map((row) => ({ ...row })),
      },
    });
    setStoragePort(port as never);
  });

  afterEach(async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const { forgetManifests } = await import("../core/context/manifest");
    forgetManifests(SESSION);
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("WS-9：显式开启 + 短历史 ⇒ 无索引头、消息与库里一致、manifest 不记 workingSet", async () => {
    /* 默认 false（DEF-1 锁定）；本用例显式开启，测工作集路径 */
    const { getContextManager } = await import("../core/context/context");
    expect(
      getContextManager().getConfig().segmentEpochs,
      "前提：默认配置下 segmentEpochs 必须是 false（DEF-1 锁定）",
    ).toBe(false);
    getContextManager().updateConfig({ segmentEpochs: true });
    expect(getContextManager().getConfig().segmentEpochs, "本用例显式开启工作集路径").toBe(true);

    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as never, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "m",
      securityMode: "full",
      contextWindow: 200_000,
      enableCompaction: false,
    });
    for await (const _event of loop.run(SESSION, "第三轮", "C:\\repo", SYSTEM_PROMPT)) void _event;

    expect(provider.requests.length, "这一轮必须真的发出过一次请求").toBe(1);
    const request = provider.requests[0];
    const texts = request.messages.map((m: any) => String(m.content ?? ""));

    /* ★ 变异点：把闸门改成「无条件生成索引」⇒ 下面这条立刻红（短历史也出现索引） */
    expect(
      texts.some((text: string) => text.includes(WORKING_SET_INDEX_HEADER)),
      "默认开启不是「无条件生成索引」：短历史放得下时不许出现索引头",
    ).toBe(false);

    /* 请求结构：system 打头，后面是库里那三条（顺序 / id / 正文一字不差） */
    expect(request.messages[0].role).toBe("system");
    const dbRows = port.__table("messages") as any[];
    const dbIds = dbRows.map((row) => String(row.id));
    const chatIds = request.messages
      .map((m: any) => m.id)
      .filter((id: unknown): id is string => typeof id === "string" && dbIds.includes(id));
    expect(chatIds, "请求里来自库的消息 id / 顺序与库里一致（没有增删、没有重排）").toEqual(dbIds);
    expect(chatIds, "短历史的顺序 = 库里的时间顺序").toEqual(["def-1", "def-2", "def-3"]);
    expect(new Set(chatIds).size, "每条历史只出现一次（工作集不许复制消息）").toBe(chatIds.length);
    const dbById = new Map(dbRows.map((row) => [row.id, String(row.content ?? "")]));
    for (const message of request.messages) {
      if (typeof message.id !== "string" || !dbById.has(message.id)) continue;
      expect(String(message.content ?? ""), `消息 ${message.id} 的正文与库里一致`).toBe(
        dbById.get(message.id),
      );
    }

    /* 清单：这一轮**没有走**工作集 ⇒ 不许写 workingSet（「没走」≠「走了但 0 条」） */
    const { listManifests } = await import("../core/context/manifest");
    const latest = listManifests(SESSION).at(-1)!;
    expect(latest.messageIds, "清单条数 = 库里三条对话消息").toEqual(["def-1", "def-2", "def-3"]);
    expect(
      latest.workingSet,
      "默认开启 + 短历史不该触发工作集：manifest.workingSet 必须是 undefined",
    ).toBeUndefined();
  });
});
