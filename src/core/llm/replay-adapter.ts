/**
 * LLM Replay Adapter
 *
 * Design (对标 DeepSeek Harness snapshot/replay testing):
 * - Records LLM API responses to in-memory snapshots
 * - Replays them in tests for deterministic, cost-free testing
 * - No real API calls needed
 *
 * S0-4: Fixed from skeleton to working implementation.
 * - createProvider() now returns a complete LLMProvider (with name, listModels, isConfigured)
 * - addResponse() allows programmatic snapshot setup without file I/O
 * - Tests verify both record-mode and replay-mode flows
 *
 * Usage in tests:
 *   const adapter = new ReplayAdapter();
 *   adapter.addResponse(request, response);
 *   const provider = adapter.createProvider();
 *   // Use provider in agentic loop — responses come from the snapshot
 */

import type { LLMProvider, LLMRequest, LLMResponse, StreamEvent, TokenUsage, ToolDefinition, ModelConfig } from "./types";

// ========== Types ==========

interface RecordedResponse {
  /** The request fingerprint (hash of messages + tools) */
  fingerprint: string;
  /** The recorded response */
  response: LLMResponse;
  /** Recorded stream events for streaming mode */
  streamEvents?: StreamEvent[];
}

// ========== Fingerprint ==========

function fingerprintRequest(request: LLMRequest): string {
  // Simple fingerprint: model + messages hash + tools hash
  const msgHash = JSON.stringify(request.messages).length.toString(36);
  const toolHash = (request.tools || []).map(t => t.name || "").join(",");
  return `${request.model}:${msgHash}:${toolHash}`;
}

// ========== Replay Adapter ==========

export class ReplayAdapter {
  private snapshots: Map<string, RecordedResponse> = new Map();
  private recordMode: boolean = false;

  constructor(snapshotPath?: string, recordMode: boolean = false) {
    this.recordMode = recordMode;
    // S0-4: In browser/Tauri environment, we use in-memory snapshots.
    // snapshotPath is accepted for API compatibility but not used for file I/O.
    // Use addResponse() to populate snapshots programmatically.
  }

  /**
   * Create a provider that either replays or records responses.
   * S0-4: Now returns a complete LLMProvider implementation.
   */
  createProvider(): LLMProvider {
    const self = this;
    return {
      id: "replay-provider",
      name: "Replay Provider",

      async listModels(): Promise<ModelConfig[]> {
        return [
          {
            id: "replay-mock",
            name: "Replay Mock Model",
            contextWindow: 128_000,
            maxOutputTokens: 4096,
            supportsTools: true,
            supportsStreaming: true,
          },
        ];
      },

      async complete(request: LLMRequest): Promise<LLMResponse> {
        const fp = fingerprintRequest(request);
        if (self.recordMode) {
          // In record mode, return a mock response and save it
          const response: LLMResponse = {
            id: `replay-${Date.now()}`,
            content: "[Replay] Mock response",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: "stop",
            model: request.model,
          };
          self.snapshots.set(fp, { fingerprint: fp, response });
          return response;
        } else {
          const recorded = self.snapshots.get(fp);
          if (!recorded) {
            throw new Error(`No snapshot found for fingerprint: ${fp}. Add responses via addResponse() first.`);
          }
          return recorded.response;
        }
      },

      async *stream(request: LLMRequest): AsyncGenerator<StreamEvent, void, unknown> {
        const fp = fingerprintRequest(request);
        const recorded = self.snapshots.get(fp);
        if (recorded?.streamEvents) {
          for (const event of recorded.streamEvents) {
            yield event;
          }
        } else if (recorded) {
          // Fallback: yield text deltas from the recorded response
          const content = recorded.response.content || "[Replay] No content";
          // Yield in chunks for realistic streaming simulation
          const chunkSize = 10;
          for (let i = 0; i < content.length; i += chunkSize) {
            yield { type: "text_delta" as const, text: content.substring(i, i + chunkSize) };
          }
          yield { type: "end" as const, finishReason: recorded.response.finishReason };
        } else {
          throw new Error(`No snapshot found for fingerprint: ${fp}. Add responses via addResponse() first.`);
        }
      },

      isConfigured(): boolean {
        return true;
      },
    };
  }

  /**
   * Add a response to the snapshot (for manual setup).
   */
  addResponse(request: LLMRequest, response: LLMResponse): void {
    const fp = fingerprintRequest(request);
    this.snapshots.set(fp, { fingerprint: fp, response });
  }

  /**
   * Add a streaming response with pre-recorded stream events.
   */
  addStreamResponse(request: LLMRequest, events: StreamEvent[]): void {
    const fp = fingerprintRequest(request);
    // Extract final response from stream events
    let content = "";
    let finishReason: "stop" | "tool_use" | "length" | "error" = "stop";
    for (const e of events) {
      if (e.type === "text_delta") content += e.text;
      if (e.type === "end") finishReason = e.finishReason as any;
    }
    const response: LLMResponse = {
      id: `replay-stream-${Date.now()}`,
      content,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason,
      model: request.model,
    };
    this.snapshots.set(fp, { fingerprint: fp, response, streamEvents: events });
  }

  /**
   * Check if a response exists for the given request.
   */
  hasResponse(request: LLMRequest): boolean {
    return this.snapshots.has(fingerprintRequest(request));
  }

  /**
   * Get the number of recorded snapshots.
   */
  get snapshotCount(): number {
    return this.snapshots.size;
  }
}
