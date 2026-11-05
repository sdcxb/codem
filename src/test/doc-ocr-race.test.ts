/**
 * OCR-2 冷启动竞态回归：引擎的 provider key 尚未由 `configureEngine` 灌入时，
 * `runDocumentOcr` 不能直接报「未配置视觉模型」；它应重试并读取已水合的设置，
 * 等 key 可用后继续转录。
 *
 * 真实现场：隔离/真实数据冷启动后立刻触发 OCR，第一次失败、手动重试成功。
 */
import { describe, expect, it, vi } from "vitest";
import { createSettingsMock } from "./settings-mock";

let attempts = 0;
const engine = {
  getConfiguredProvider: vi.fn(() => {
    attempts += 1;
    if (attempts < 3) return null;
    return { provider: { id: "deepseek" }, model: "deepseek-flash" };
  }),
  getProviderConfig: vi.fn(() => ({ apiKey: "sk-test", baseUrl: "" })),
  setProviderConfig: vi.fn(),
  registerCustomProvider: vi.fn(),
};

vi.mock("../core/llm", () => ({ getLLMEngine: () => engine }));
vi.mock("../core/llm/vision-proxy", () => ({
  VisionProxy: class {
    getVisionConfig() {
      return null;
    }
    async describeImageWith() {
      return "视觉转录：冷启动后的第一页";
    }
  },
}));
vi.mock("../core/storage/settings", () => ({
  ...createSettingsMock(),
  getSettingJSON: () => ({ providers: [{ id: "deepseek", apiKey: "sk-test" }] }),
}));
vi.mock("../core/storage/secret-store", () => ({
  ensureSecretsHydrated: async () => ({ unsealed: 1, failed: 0, backend: true, settingsReady: true }),
}));

import { runDocumentOcr, type OcrHost } from "../core/document/ocr";

function host(): { host: OcrHost; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    host: {
      pending: async () => [{ page_no: 1, kind: "scanned" }],
      render: async (_id, page_no) => ({
        page_no,
        media_type: "image/png",
        data: "png",
        width: 800,
        height: 1100,
      }),
      write: async (_id, _page, text) => {
        writes.push(text);
        return {};
      },
      finish: async () => ({ remaining: 0, status: "ready" }),
      fail: async () => ({}),
      updateStatus: async () => ({}),
    },
  };
}

describe("OCR-2 冷启动 provider key 竞态", () => {
  it("前两次解析失败会自动重试，第三次拿到 key 后继续转录", async () => {
    const h = host();
    const res = await runDocumentOcr("doc-race", { host: h.host });
    expect(res).toMatchObject({ pages: 1, written: 1, failed: 0, model: "deepseek-flash" });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(h.writes[0]).toContain("冷启动后的第一页");
    expect(engine.setProviderConfig).toHaveBeenCalled();
  }, 10000);
});
