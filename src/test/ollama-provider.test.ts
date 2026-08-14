/**
 * P3-31: Ollama Provider — Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "../core/llm/ollama-provider";

// Mock settings
vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn((key: string) => {
    if (key === "ollama-base-url") return "http://localhost:11434";
    if (key === "ollama-auto-detect") return "true";
    return "";
  }),
  setSetting: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// Mock AbortSignal.timeout
global.AbortSignal.timeout = ((ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}) as any;

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider();
    vi.clearAllMocks();
  });

  describe("Basic Properties", () => {
    it("should have id 'ollama'", () => {
      expect(provider.id).toBe("ollama");
    });

    it("should always be configured (no API key needed)", () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it("should return default base URL from settings", () => {
      expect(provider.getBaseUrl()).toBe("http://localhost:11434");
    });
  });

  describe("checkConnection", () => {
    it("should return connected=true when Ollama API is available", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "llama3.2", model: "llama3.2" }] }),
      });

      const status = await provider.checkConnection();

      expect(status.connected).toBe(true);
      expect(status.modelCount).toBe(1);
      expect(status.url).toBe("http://localhost:11434");
    });

    it("should return connected=false when fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const status = await provider.checkConnection();

      expect(status.connected).toBe(false);
      expect(status.error).toContain("Connection refused");
    });

    it("should return connected=false when API returns error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const status = await provider.checkConnection();

      expect(status.connected).toBe(false);
      expect(status.error).toContain("500");
    });
  });

  describe("listModels", () => {
    it("should parse Ollama models into ModelConfig[]", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: "llama3.2:latest",
              model: "llama3.2:latest",
              size: 3825819519,
              digest: "abc123",
              modifiedAt: "2024-01-01T00:00:00Z",
              details: { family: "llama", parameterSize: "3B", quantizationLevel: "Q4_0" },
            },
            {
              name: "qwen2.5:7b",
              model: "qwen2.5:7b",
              size: 4500000000,
              digest: "def456",
              modifiedAt: "2024-01-02T00:00:00Z",
              details: { family: "qwen", parameterSize: "7B", quantizationLevel: "Q4_0" },
            },
          ],
        }),
      });

      const models = await provider.listModels();

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("llama3.2:latest");
      expect(models[0].supportsTools).toBe(true); // llama3 supports tools
      expect(models[0].costPer1kInput).toBe(0); // Free
      expect(models[0].costPer1kOutput).toBe(0);
      expect(models[1].id).toBe("qwen2.5:7b");
      expect(models[1].supportsTools).toBe(true); // qwen supports tools
    });

    it("should return empty array when fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const models = await provider.listModels();

      expect(models).toEqual([]);
    });

    it("should return empty array when no models installed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      const models = await provider.listModels();

      expect(models).toEqual([]);
    });
  });

  describe("Context Window Estimation", () => {
    it("should estimate llama3 context window as 128K", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{
            name: "llama3.1:8b",
            model: "llama3.1:8b",
            details: { parameterSize: "8B", quantizationLevel: "Q4_0" },
          }],
        }),
      });

      const models = await provider.listModels();

      expect(models[0].contextWindow).toBe(128000);
    });

    it("should estimate qwen2.5 context window as 32K", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{
            name: "qwen2.5:14b",
            model: "qwen2.5:14b",
            details: { parameterSize: "14B", quantizationLevel: "Q4_0" },
          }],
        }),
      });

      const models = await provider.listModels();

      expect(models[0].contextWindow).toBe(32768);
    });

    it("should estimate deepseek context window as 65K", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{
            name: "deepseek-r1:14b",
            model: "deepseek-r1:14b",
            details: { parameterSize: "14B", quantizationLevel: "Q4_0" },
          }],
        }),
      });

      const models = await provider.listModels();

      expect(models[0].contextWindow).toBe(65536);
    });
  });
});
