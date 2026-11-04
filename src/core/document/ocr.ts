/**
 * 文档视觉转录（P1，ADR-0008 §15）：把图片页/扫描页交给**视觉模型**转成可检索文本。
 *
 * ## 分工（为什么不放在 Rust 里调模型）
 *
 * Rust 负责「渲染页面 → PNG」，渲染侧负责「调用视觉模型 → 写回转录文本」：
 * API key 与 provider 配置本来就在渲染侧（设置/引擎），Rust 再读一遍等于复制一份凭据通道；
 * 而且视觉调用的重试/模型目录健康度（`catalog-health`）都已有现成实现。
 *
 * ## 索引一致性
 *
 * 转录文本由 Rust 追加到正文侧车并**同时**建块/分块/FTS（`documents_ocr_write`），
 * 所以 `doc_search`/`doc_read` 对转录页与普通文本页的行为完全一致；
 * 页状态 `ocr_state=done / ocr_model=<model>` 让 UI 能如实展示来源。
 */

import { getLLMEngine } from "../llm";
import { modelSupportsVision } from "../llm/model-capabilities";
import { VisionProxy } from "../llm/vision-proxy";
import type { MultimodalProviderConfig } from "../llm/multimodal";
import {
  finishDocumentOcr,
  markDocumentOcrFailed,
  ocrPendingPages,
  renderDocumentPage,
  updateDocumentStatus,
  writeDocumentOcrPage,
  type OcrPendingPage,
  type RenderedPagePng,
} from "./client";

/** OCR 需要的宿主能力（测试可注入假实现）。 */
export interface OcrHost {
  pending(documentId: string): Promise<OcrPendingPage[]>;
  render(documentId: string, pageNo: number): Promise<RenderedPagePng>;
  write(documentId: string, pageNo: number, text: string, model: string): Promise<unknown>;
  finish(documentId: string): Promise<{ remaining: number; status: string }>;
  fail(documentId: string, pageNo: number): Promise<unknown>;
  updateStatus(documentId: string, patch: Record<string, unknown>): Promise<unknown>;
}

const tauriOcrHost: OcrHost = {
  pending: (documentId) => ocrPendingPages(documentId),
  render: (documentId, pageNo) => renderDocumentPage(documentId, pageNo),
  write: (documentId, pageNo, text, model) =>
    writeDocumentOcrPage({ documentId, pageNo, text, model }),
  finish: (documentId) => finishDocumentOcr(documentId),
  fail: (documentId, pageNo) => markDocumentOcrFailed(documentId, pageNo),
  updateStatus: (documentId, patch) => updateDocumentStatus(documentId, patch),
};

export interface OcrDescriber {
  model: string;
  providerId: string;
  describe(base64Png: string, mediaType: string, prompt: string): Promise<string>;
}

/**
 * 转录提示词：**只要文字，不要描述版式**。
 *
 * 这里刻意与「看图说话」的视觉提示分开：文档索引需要的是可检索正文，
 * 模型对配色的描述会污染检索（用户搜「蓝色」命中一页无关的图）。
 */
const OCR_PROMPT = [
  "你在为一页文档建立全文索引。请只输出这一页上的**文字内容**：",
  "1) 保持原有的标题、段落、列表、表格结构（表格用 Markdown 表格）；",
  "2) 不要描述版式、颜色、字体或图片内容；",
  "3) 手写/模糊处写 [无法辨认]，不要猜测；",
  "4) 如果这一页确实没有任何文字，只输出：[本页无可提取文字]。",
].join("\n");

/**
 * 解析当前可用的视觉模型：主对话模型原生支持视觉就用它；否则用「设置 → 多模态 → Vision」的代理。
 * 两者都没有 ⇒ 抛出可行动的错误（调用方把文档保持 `needs_ocr`，不假装已索引）。
 */
function resolveOcrDescriber(): OcrDescriber {
  const proxy = new VisionProxy();
  let chat: MultimodalProviderConfig | null = null;
  try {
    const engine = getLLMEngine();
    const slot = engine.getConfiguredProvider("chat" as any);
    if (slot && modelSupportsVision(slot.model)) {
      const cfg = engine.getProviderConfig(slot.provider.id);
      if (cfg) {
        chat = {
          providerId: slot.provider.id,
          apiKey: cfg.apiKey ?? "",
          baseUrl: cfg.baseUrl || "",
          model: slot.model,
          enabled: true,
        };
      }
    }
  } catch {
    // 引擎/场景模板尚未就绪：回退到视觉代理
    chat = null;
  }
  const target = chat ?? proxy.getVisionConfig();
  if (!target) {
    throw new Error(
      "未配置视觉模型：当前主模型不支持视觉，且 设置→多模态→Vision 未启用。配置后可重试视觉转录。",
    );
  }
  return {
    model: target.model,
    providerId: target.providerId,
    describe: (data, mediaType, prompt) => proxy.describeImageWith(target, data, mediaType, prompt),
  };
}

export interface OcrRunResult {
  pages: number;
  written: number;
  failed: number;
  model: string;
  status: string;
}

export interface OcrRunOptions {
  host?: OcrHost;
  /** 测试注入；缺省用 `resolveOcrDescriber()` */
  describer?: OcrDescriber;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 对一份文档执行视觉转录。逐页串行（视觉接口本就慢；并发会增加限流/计费失控风险）。
 * 单页失败不放弃整份文档：跳过该页、继续下一页，最后把失败原因写回文档 `error`。
 */
export async function runDocumentOcr(
  documentId: string,
  options: OcrRunOptions = {},
): Promise<OcrRunResult> {
  const host = options.host ?? tauriOcrHost;
  const pages = await host.pending(documentId);
  if (pages.length === 0) {
    const fin = await host.finish(documentId);
    return { pages: 0, written: 0, failed: 0, model: "", status: fin.status };
  }

  const describer = options.describer ?? resolveOcrDescriber();
  let written = 0;
  const errors: string[] = [];

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    try {
      const rendered = await host.render(documentId, page.page_no);
      const text = (await describer.describe(rendered.data, rendered.media_type, OCR_PROMPT)).trim();
      if (!text) throw new Error("模型返回空文本");
      await host.write(documentId, page.page_no, text, describer.model);
      written += 1;
    } catch (e: any) {
      errors.push(`第 ${page.page_no} 页：${e?.message ?? e}`);
      // 页级失败要留痕（重跑会再列出该页），不能只把整份文档留在 needs_ocr
      await host.fail(documentId, page.page_no).catch(() => undefined);
    }
    options.onProgress?.(i + 1, pages.length);
  }

  const fin = await host.finish(documentId);
  if (errors.length > 0) {
    await host
      .updateStatus(documentId, {
        error: `视觉转录 ${errors.length}/${pages.length} 页失败：${errors.slice(0, 3).join("；")}`,
      })
      .catch(() => undefined);
  }
  return {
    pages: pages.length,
    written,
    failed: errors.length,
    model: describer.model,
    status: fin.status,
  };
}
