/**
 * 自动压缩的**触发路径**端到端判据（AUTOCOMPACT-*）。
 *
 * ## 为什么需要它
 *
 * 压缩的**机制**早就有一堆判据（`doCompactMessages` 被直接调用、HEADROOM 断言阈值与保留预算），
 * 但「水位真的涨过 70% → 循环自己触发压缩 → 事件发出来 → 历史真的变短」这条链
 * **没有任何用例走过**：`compaction_start/end` 此前只被「类型可构造」断言过。
 *
 * 这组用例从 `run()` 真的跑一遍：预置一段超过窗口的历史 → 收集事件 → 断言
 * ① 压缩真的被触发；② 事件里报告移除了消息；③ 历史里出现压缩标记（软删 + 标记替换，
 * 原文不销毁）；④ 压缩后的请求确实比压缩前小。
 *
 * 它**不是**真机验证：这里没有打包应用、没有真实 provider、没有 UI 横幅/重载。
 * 真机那一步仍然要做（见 `docs/project-guide/16-MCODE-STACK-AUDIT.md` §6.1）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { setStoragePort, type StoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getTokenTracker } from "../core/llm/token-tracker";
import { listMessages } from "../core/storage/message";

const SESSION = "auto-compact-trigger";
const CWD = "C:\\auto-compact";
const SYSTEM_PROMPT = "你是测试用助手。";
const WINDOW = 24_000;

let port: FakeStoragePort;
let logSpy: any;

function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedSession(id: string) {
  seedRow("sessions", {
    id,
    project_id: "p1",
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
  });
}

/** 一段足够长的中文正文（估算器按 CJK 计，1200 字 ≈ 上千 token） */
function body(tag: string, n = 1200): string {
  return `${tag}：` + "上下文压缩触发判据的填充正文。".repeat(Math.ceil(n / 16));
}

class RecordingProvider {
  id = "ac-provider";
  name = "AutoCompact Mock";
  requests: any[] = [];
  completes: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete(request: any) {
    this.completes.push(request);
    return {
      content: "结构化摘要：已完成 A，待办 B。",
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

beforeEach(() => {
  port = createFakeStoragePort();
  setStoragePort(port as unknown as StoragePort);
  getTokenTracker().setContextWindow(WINDOW);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("AUTOCOMPACT：自动压缩的触发路径", () => {
  it("水位超过阈值时，run() 自己触发压缩、发出事件、历史变短", async () => {
    seedSession(SESSION);

    // 60 条历史（30 轮），每条 800 字 —— 既超过 24k 窗口的 70%，也让待压集跨过中间档
    // （跨档才会真的调用 LLM 摘要；只压中间档时是确定性要点，不调模型）
    for (let i = 0; i < 60; i += 1) {
      seedRow("messages", {
        id: `ac-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`第 ${i} 条`, 800),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 2,
      model: "ac-model",
      securityMode: "full",
      contextWindow: WINDOW,
      enableCompaction: true,
      compactionThreshold: 0.7,
    });

    const events: any[] = [];
    for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) {
      events.push(event);
    }

    const start = events.find((e) => e.type === "compaction_start");
    const end = events.find((e) => e.type === "compaction_end");
    expect(start, `没有触发压缩；事件序列=${events.map((e) => e.type).join(",")}`).toBeTruthy();
    expect(end, "压缩开始后必须发结束事件（否则 UI 横幅永远挂着）").toBeTruthy();
    expect(end.messagesRemoved, "压缩必须真的移除消息（0 = 没压）").toBeGreaterThan(0);
    expect(provider.completes.length, "压缩摘要走 complete()，至少调用一次").toBeGreaterThan(0);
    const compactLog = logSpy.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((line: string) => line.startsWith("[compact] usage"));
    expect(compactLog, "压缩调用必须留一行 usage 读数（否则压缩成本不可观测）").toBeTruthy();
    expect(compactLog).toContain("prompt=100");
    expect(compactLog, "provider 没报缓存字段时不许编 0").toContain("cacheHit=?");

    // 历史里出现压缩标记（原文软删 + 标记是唯一副本，不是物理删除）
    const after = listMessages(SESSION);
    const marker = after.find(
      (m) => m.role === "user" && /\[上下文已(自动|手动)压缩\]/.test(String(m.content ?? "")),
    );
    expect(marker, "压缩后必须留下摘要标记（否则模型与用户都看不到发生过什么）").toBeTruthy();
    expect(after.length, "压缩后历史条数应变少").toBeLessThan(61);

    // 压缩后的请求确实比压缩前小（否则只是"发了个事件"）
    const sizes = provider.requests.map((r) => JSON.stringify(r.messages).length);
    const firstSize = sizes[0];
    const lastSize = sizes[sizes.length - 1];
    expect(lastSize, `压缩后的请求应当更小：first=${firstSize} last=${lastSize}`).toBeLessThan(firstSize);
  });
});
