/**
 * VISION-1/2：模型视觉能力的**唯一真源**与视觉代理路由。
 *
 * 真机 bug（用户截图）：设置里选 `deepseek-flash`（原生多模态），输入区却提示
 * 「当前模型不支持视觉，图片将以文字标注发送」。
 *
 * 根因是三份能力表漂移：
 *   · `InputArea.modelSupportsVision`（没 deepseek-flash）
 *   · `capability-detector` 的 DB（有 deepseek-flash）
 *   · `vision-proxy` 的私有前缀表（没 deepseek-flash ⇒ 图片还会被送去代理）
 *
 * 本判据钉住：①能力判定结果；②三处实现只剩一处（结构断言，防再次分叉）；
 * ③视觉代理对 deepseek-flash 的图片**必须原样放行**（不调 fetch、不替换 block）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { lookupModelCapabilities, modelSupportsVision } from "../core/llm/model-capabilities";
import { VisionProxy } from "../core/llm/vision-proxy";
import type { ContentBlock, LLMMessage } from "../core/storage/message";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

afterEach(() => vi.restoreAllMocks());

describe("VISION-1 能力判定（唯一真源）", () => {
  it("deepseek-flash 及其别名是原生多模态", () => {
    for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "DeepSeek-Flash"]) {
      expect(modelSupportsVision(id), `${id} 必须判定为支持视觉`).toBe(true);
    }
    expect(lookupModelCapabilities("deepseek-flash")?.supportsTools).toBe(true);
  });

  it("纯文本/未知模型保守为 false（不猜）", () => {
    for (const id of ["deepseek-v4-pro", "deepseek-chat", "mimo-v2.5-pro", "", "  ", "unknown-x"]) {
      expect(modelSupportsVision(id), `${id} 应保守判定为不支持`).toBe(false);
    }
  });

  it("mimo-v2.5-pro 不被 mimo-v2.5 的前缀吃掉", () => {
    expect(modelSupportsVision("mimo-v2.5")).toBe(true);
    expect(modelSupportsVision("mimo-v2.5-pro")).toBe(false);
  });

  it("三处实现只剩一处（结构断言，防止再次分叉）", () => {
    const inputArea = read("src/components/InputArea.tsx");
    expect(inputArea, "InputArea 不得再自带能力表").not.toMatch(/function\s+modelSupportsVision/);
    expect(inputArea).toContain('from "../core/llm/model-capabilities"');

    const detector = read("src/core/llm/capability-detector.ts");
    expect(detector, "capability-detector 不得再自带能力表").not.toContain("MODEL_CAPABILITY_DB");
    expect(detector).toContain("lookupModelCapabilities");

    const proxy = read("src/core/llm/vision-proxy.ts");
    expect(proxy, "vision-proxy 必须委托唯一真源").toContain("modelHasNativeVision(");
    expect(proxy, "vision-proxy 不得再维护自己的前缀表").not.toContain('startsWith("deepseek-v4-flash-vision")');
  });
});

describe("VISION-2 视觉代理路由", () => {
  function imageMessage(): LLMMessage {
    return {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
      ] satisfies ContentBlock[],
    };
  }

  it("deepseek-flash：图片原样放行，不调用视觉代理、不发网络请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const proxy = new VisionProxy();
    const result = await proxy.processMessages([imageMessage()], "deepseek-flash", "deepseek");

    expect(result.visionUsed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    const blocks = result.messages[0].content as ContentBlock[];
    expect(blocks.some((b) => b.type === "image")).toBe(true);
    expect(blocks.some((b) => b.type === "image" && (b as any).data === "aGVsbG8=")).toBe(true);
  });

  it("纯文本模型 + 无视觉代理配置：图片被标记为未处理（不假装已理解）", async () => {
    const proxy = new VisionProxy();
    const result = await proxy.processMessages([imageMessage()], "deepseek-v4-pro", "deepseek");
    expect(result.visionUsed).toBe(false);
    const blocks = result.messages[0].content as ContentBlock[];
    expect(blocks.some((b) => b.type === "image")).toBe(false);
  });
});
