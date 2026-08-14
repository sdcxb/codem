/**
 * S0-4: Replay Adapter — Snapshot Replay Tests
 *
 * Tests:
 * 1. addResponse + complete() returns recorded response
 * 2. complete() throws when no snapshot exists
 * 3. addStreamResponse + stream() yields recorded events
 * 4. stream() falls back to chunked text when no explicit stream events
 * 5. Record mode auto-generates mock responses
 * 6. hasResponse() correctly detects presence/absence
 * 7. createProvider() returns a complete LLMProvider interface
 * 8. Fingerprint consistency — same request matches same snapshot
 */

import { describe, it, expect } from "vitest";
import { ReplayAdapter } from "../core/llm/replay-adapter";
import type { LLMRequest, LLMResponse, StreamEvent } from "../core/llm/types";

function makeRequest(model = "test-model"): LLMRequest {
  return {
    model,
    messages: [
      { role: "user", content: "Hello, how are you?" },
    ],
  };
}

function makeResponse(content: string, model = "test-model"): LLMResponse {
  return {
    id: `resp-${Date.now()}`,
    content,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop",
    model,
  };
}

describe("S0-4: Replay Adapter", () => {
  // Test 1: addResponse + complete() returns recorded response
  it("returns the recorded response via complete()", async () => {
    const adapter = new ReplayAdapter();
    const req = makeRequest();
    const resp = makeResponse("Hello from the replay!");
    adapter.addResponse(req, resp);

    const provider = adapter.createProvider();
    const result = await provider.complete(req);

    expect(result.content).toBe("Hello from the replay!");
    expect(result.model).toBe("test-model");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.totalTokens).toBe(15);
  });

  // Test 2: complete() throws when no snapshot exists
  it("throws when no snapshot exists for the request", async () => {
    const adapter = new ReplayAdapter();
    const provider = adapter.createProvider();

    await expect(provider.complete(makeRequest())).rejects.toThrow(
      "No snapshot found for fingerprint"
    );
  });

  // Test 3: addStreamResponse + stream() yields recorded events
  it("yields recorded stream events via stream()", async () => {
    const adapter = new ReplayAdapter();
    const req = makeRequest();
    const events: StreamEvent[] = [
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world!" },
      { type: "end", finishReason: "stop" },
    ];
    adapter.addStreamResponse(req, events);

    const provider = adapter.createProvider();
    const yielded: StreamEvent[] = [];
    for await (const event of provider.stream(req)) {
      yielded.push(event);
    }

    expect(yielded).toHaveLength(3);
    expect(yielded[0]).toEqual({ type: "text_delta", text: "Hello " });
    expect(yielded[1]).toEqual({ type: "text_delta", text: "world!" });
    expect(yielded[2]).toEqual({ type: "end", finishReason: "stop" });
  });

  // Test 4: stream() falls back to chunked text when no explicit stream events
  it("falls back to chunked text streaming when no stream events recorded", async () => {
    const adapter = new ReplayAdapter();
    const req = makeRequest();
    const resp = makeResponse("ABCDEFGHIJ"); // exactly 10 chars = 1 chunk
    adapter.addResponse(req, resp);

    const provider = adapter.createProvider();
    const yielded: StreamEvent[] = [];
    for await (const event of provider.stream(req)) {
      yielded.push(event);
    }

    // Should yield 1 text_delta (10 chars) + 1 end event
    expect(yielded).toHaveLength(2);
    expect(yielded[0].type).toBe("text_delta");
    expect((yielded[0] as any).text).toBe("ABCDEFGHIJ");
    expect(yielded[1].type).toBe("end");
  });

  // Test 5: Record mode auto-generates mock responses
  it("auto-generates mock responses in record mode", async () => {
    const adapter = new ReplayAdapter(undefined, true);
    const req = makeRequest();
    const provider = adapter.createProvider();

    const result = await provider.complete(req);
    expect(result.content).toBe("[Replay] Mock response");
    expect(result.model).toBe("test-model");

    // The mock should be saved — switching to replay mode should find it
    expect(adapter.hasResponse(req)).toBe(true);
    expect(adapter.snapshotCount).toBe(1);
  });

  // Test 6: hasResponse() correctly detects presence/absence
  it("hasResponse() returns true for added, false for missing", () => {
    const adapter = new ReplayAdapter();
    const req1 = makeRequest("model-a");
    const req2 = makeRequest("model-b");

    adapter.addResponse(req1, makeResponse("response A", "model-a"));

    expect(adapter.hasResponse(req1)).toBe(true);
    expect(adapter.hasResponse(req2)).toBe(false);
  });

  // Test 7: createProvider() returns a complete LLMProvider interface
  it("createProvider() returns a complete LLMProvider", async () => {
    const adapter = new ReplayAdapter();
    const provider = adapter.createProvider();

    // Must have all LLMProvider interface members
    expect(provider.id).toBe("replay-provider");
    expect(provider.name).toBe("Replay Provider");
    expect(typeof provider.listModels).toBe("function");
    expect(typeof provider.complete).toBe("function");
    expect(typeof provider.stream).toBe("function");
    expect(typeof provider.isConfigured).toBe("function");

    // listModels should return at least one model
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("replay-mock");

    // isConfigured should return true
    expect(provider.isConfigured()).toBe(true);
  });

  // Test 8: Fingerprint consistency — same request matches same snapshot
  it("uses consistent fingerprinting for identical requests", async () => {
    const adapter = new ReplayAdapter();
    const req1 = makeRequest("fingerprint-test");
    const req2 = makeRequest("fingerprint-test");

    adapter.addResponse(req1, makeResponse("matched!", "fingerprint-test"));

    // req2 is a different object but same content → same fingerprint
    expect(adapter.hasResponse(req2)).toBe(true);

    const provider = adapter.createProvider();
    const result = await provider.complete(req2);
    expect(result.content).toBe("matched!");
  });
});
