/**
 * 视觉转录编排（P1）：逐页渲染 → 视觉模型 → 写回索引 → 收尾。
 *
 * 这里用可注入的 host/describer 测**编排契约**（真实 Rust/PDFium 路径由
 * `documents/pdf.rs` 的 ignored 真机用例覆盖）：
 * 1. 每页都要 render + describe + write，顺序与页号一致；
 * 2. 单页失败不放弃整份文档，失败原因写回文档 error；
 * 3. 全部完成后调用 finish（把 needs_ocr 转 ready）。
 */
import { describe, expect, it, vi } from "vitest";
import { runDocumentOcr, type OcrDescriber, type OcrHost } from "../core/document/ocr";

function makeHost(pages = [1, 2]) {
  const writes: Array<{ pageNo: number; text: string; model: string }> = [];
  const statusPatches: Array<Record<string, unknown>> = [];
  let finished = 0;
  const host: OcrHost = {
    pending: vi.fn(async () => pages.map((page_no) => ({ page_no, kind: "scanned" }))),
    render: vi.fn(async (_id: string, page_no: number) => ({
      page_no,
      media_type: "image/png",
      data: `png-${page_no}`,
      width: 800,
      height: 1100,
    })),
    write: vi.fn(async (_id: string, pageNo: number, text: string, model: string) => {
      writes.push({ pageNo, text, model });
      return { chunk_no: pageNo };
    }),
    finish: vi.fn(async () => {
      finished += 1;
      return { remaining: 0, status: "ready" };
    }),
    fail: vi.fn(async () => ({})),
    updateStatus: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      statusPatches.push(patch);
      return {};
    }),
  };
  return { host, writes, statusPatches, finishes: () => finished };
}

const describer: OcrDescriber = {
  model: "deepseek-flash",
  providerId: "deepseek",
  describe: vi.fn(async (_data: string, _media: string, prompt: string) => {
    expect(prompt).toContain("只输出这一页上的");
    return "视觉转录：迁移步骤与验收";
  }),
};

describe("OCR-1 逐页转录", () => {
  it("两页都渲染/转录/写回，进度按页上报，最后 finish", async () => {
    const { host, writes, finishes } = makeHost();
    const progress: Array<[number, number]> = [];
    const result = await runDocumentOcr("doc-1", {
      host,
      describer,
      onProgress: (d, t) => progress.push([d, t]),
    });

    expect(result).toMatchObject({ pages: 2, written: 2, failed: 0, model: "deepseek-flash", status: "ready" });
    expect(host.render).toHaveBeenCalledTimes(2);
    expect(host.render).toHaveBeenNthCalledWith(1, "doc-1", 1);
    expect(host.render).toHaveBeenNthCalledWith(2, "doc-1", 2);
    expect(writes.map((w) => w.pageNo)).toEqual([1, 2]);
    expect(writes.every((w) => w.model === "deepseek-flash")).toBe(true);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(finishes()).toBe(1);
  });

  it("没有待转录页时仍调用 finish（把历史 needs_ocr 收敛成 ready）", async () => {
    const { host, writes, finishes } = makeHost([]);
    const result = await runDocumentOcr("doc-2", { host, describer });
    expect(result).toMatchObject({ pages: 0, written: 0, status: "ready" });
    expect(writes).toHaveLength(0);
    expect(finishes()).toBe(1);
  });
});

describe("OCR-2 失败不放弃整份文档", () => {
  it("第 2 页失败：第 1 页仍写回，错误写进文档 error", async () => {
    const { host, writes, statusPatches } = makeHost();
    const flaky: OcrDescriber = {
      model: "deepseek-flash",
      providerId: "deepseek",
      describe: vi.fn(async (_d, _m, _p) => {
        if ((flaky.describe as any).mock.calls.length === 2) throw new Error("视觉接口 429");
        return "第一页文字";
      }),
    };
    const result = await runDocumentOcr("doc-3", { host, describer: flaky });
    expect(result).toMatchObject({ pages: 2, written: 1, failed: 1 });
    expect(writes).toHaveLength(1);
    expect(host.fail).toHaveBeenCalledWith("doc-3", 2);
    expect(statusPatches).toHaveLength(1);
    expect(String(statusPatches[0].error)).toContain("第 2 页");
  });

  it("模型返回空文本也算失败（不写空块污染索引）", async () => {
    const { host, writes } = makeHost([1]);
    const empty: OcrDescriber = {
      model: "x",
      providerId: "p",
      describe: vi.fn(async () => "   "),
    };
    const result = await runDocumentOcr("doc-4", { host, describer: empty });
    expect(result.failed).toBe(1);
    expect(writes).toHaveLength(0);
  });
});
