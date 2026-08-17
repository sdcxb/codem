/**
 * D4: Test Layers — 测试分层框架
 *
 * 设计对标 DSH `__snapshots__/` + `e2e/` 测试分层体系。
 *
 * 三层测试架构：
 *
 * 1. Unit Layer (已有) — 纯函数/类单元测试
 *    - 不依赖外部服务
 *    - 使用 mock/stub
 *    - 快速执行（<1s per test）
 *
 * 2. Snapshot Layer (新增) — LLM 响应快照回归测试
 *    - 录制 LLM API 响应到快照文件
 *    - 回放快照进行确定性测试
 *    - 使用 ReplayAdapter（无需真实 API 调用）
 *    - 检测 prompt 变化导致的响应漂移
 *
 * 3. Real-API E2E Layer (新增) — 真实 API 端到端测试
 *    - 使用真实 LLM API
 *    - 验证完整链路（prompt → API → tools → response）
 *    - 需要环境变量 CODEM_E2E_API_KEY
 *    - 慢速执行，仅 CI 或手动触发
 *
 * 使用方式：
 * - 默认：运行 Unit + Snapshot 层（无需 API key）
 * - E2E：设置 CODEM_E2E_API_KEY 后运行
 * - 回归：设置 CODEM_UPDATE_SNAPSHOTS=1 更新快照
 */

// ========== Layer Selection ==========

export type TestLayer = "unit" | "snapshot" | "e2e";

export function shouldRunLayer(layer: TestLayer): boolean {
  switch (layer) {
    case "unit":
      return true; // Always run unit tests
    case "snapshot":
      // Run snapshot tests when not in e2e-only mode
      return process.env.CODEM_E2E_ONLY !== "1";
    case "e2e":
      // Only run e2e tests when API key is available
      return !!process.env.CODEM_E2E_API_KEY;
  }
}

export function shouldUpdateSnapshots(): boolean {
  return process.env.CODEM_UPDATE_SNAPSHOTS === "1";
}

export function isE2EMode(): boolean {
  return !!process.env.CODEM_E2E_API_KEY;
}

// ========== Snapshot Manager ==========

export interface SnapshotEntry {
  /** 请求指纹 */
  fingerprint: string;
  /** 录制的响应 */
  response: unknown;
  /** 录制时间 */
  recordedAt: number;
  /** 模型名称 */
  model: string;
  /** Prompt hash（检测 prompt 变化） */
  promptHash: string;
}

export class SnapshotManager {
  private snapshots = new Map<string, SnapshotEntry>();
  private storageKey = "codem-test-snapshots";

  /** 录制一个快照 */
  record(fingerprint: string, response: unknown, model: string, promptHash: string): void {
    this.snapshots.set(fingerprint, {
      fingerprint,
      response,
      recordedAt: Date.now(),
      model,
      promptHash,
    });
    this.persist();
  }

  /** 获取一个快照 */
  get(fingerprint: string): SnapshotEntry | null {
    return this.snapshots.get(fingerprint) || null;
  }

  /** 检查快照是否存在且 prompt 未变化 */
  isValid(fingerprint: string, promptHash: string): boolean {
    const entry = this.snapshots.get(fingerprint);
    if (!entry) return false;
    return entry.promptHash === promptHash;
  }

  /** 列出所有快照 */
  list(): SnapshotEntry[] {
    return [...this.snapshots.values()];
  }

  /** 清除所有快照 */
  clear(): void {
    this.snapshots.clear();
    this.persist();
  }

  /** 持久化到 SQLite settings */
  private persist(): void {
    try {
      const { setSettingJSON } = require("../storage/settings");
      setSettingJSON(this.storageKey, [...this.snapshots.values()]);
    } catch {
      // Non-critical — snapshots are test-only
    }
  }

  /** 从 SQLite settings 加载 */
  load(): void {
    try {
      const { getSettingJSON } = require("../storage/settings");
      const entries = getSettingJSON(this.storageKey, []) as SnapshotEntry[];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          this.snapshots.set(entry.fingerprint, entry);
        }
      }
    } catch {
      // Non-critical
    }
  }
}

// ========== Singleton ==========

let snapshotManager: SnapshotManager | null = null;

export function getSnapshotManager(): SnapshotManager {
  if (!snapshotManager) {
    snapshotManager = new SnapshotManager();
    snapshotManager.load();
  }
  return snapshotManager;
}

// ========== E2E Test Helpers ==========

/**
 * E2E 测试辅助函数 — 创建真实 LLM 调用
 * 仅在 CODEM_E2E_API_KEY 设置时可用
 */
export async function createE2EProvider(): Promise<import("./types").LLMProvider | null> {
  if (!isE2EMode()) return null;

  const apiKey = process.env.CODEM_E2E_API_KEY!;
  const model = process.env.CODEM_E2E_MODEL || "gpt-4o-mini";
  const baseUrl = process.env.CODEM_E2E_BASE_URL || "https://api.openai.com/v1";

  const { OpenAICompatibleProvider } = await import("./provider");
  return new OpenAICompatibleProvider({
    id: "e2e",
    name: "E2E Test",
    apiKey,
    baseUrl,
    models: [
      {
        id: model,
        name: model,
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  } as any);
}

/**
 * E2E 测试辅助函数 — 发送一个完整请求并验证响应
 */
export async function e2eRequest(
  provider: import("./types").LLMProvider,
  messages: import("./types").LLMMessage[],
  tools: import("./types").ToolDefinition[] = [],
): Promise<import("./types").LLMResponse> {
  const model = (provider as any).config?.models?.[0]?.id || "gpt-4o-mini";
  const events: import("./types").StreamEvent[] = [];

  for await (const event of provider.stream({
    model,
    messages,
    tools,
    temperature: 0, // Deterministic for e2e
    maxTokens: 1000,
  })) {
    events.push(event);
  }

  // Reconstruct response from stream events
  let content = "";
  let reasoning = "";
  let toolCalls: any[] = [];
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const event of events) {
    if (event.type === "text_delta") content += event.text;
    if (event.type === "reasoning_delta") reasoning += event.text;
    if (event.type === "tool_use_end") toolCalls.push({ id: event.id, name: event.name || "", input: event.input || {} });
    if (event.type === "usage") usage = event.usage;
  }

  return {
    id: "e2e-response",
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason: "stop",
    model,
  } as import("./types").LLMResponse;
}

// ========== Test Result Reporter ==========

export interface TestLayerResult {
  layer: TestLayer;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export class TestLayerReporter {
  private results: TestLayerResult[] = [];

  record(result: TestLayerResult): void {
    this.results.push(result);
  }

  getResults(): TestLayerResult[] {
    return this.results;
  }

  summary(): string {
    const lines: string[] = ["Test Layer Results:"];
    for (const r of this.results) {
      const status = r.failed === 0 ? "✅" : "❌";
      lines.push(
        `  ${status} ${r.layer}: ${r.passed}/${r.total} passed, ${r.failed} failed, ${r.skipped} skipped (${r.durationMs}ms)`,
      );
    }
    return lines.join("\n");
  }
}
