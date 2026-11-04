/**
 * DOCI-3 / DOCI-4 / DOCI-10：三条入口 + 分块边界。
 *
 * 断言的是**入口到摄取**这条链的形状：
 * - 路径：存在 + 文档扩展名 + 允许根 + 代码围栏剔除，缺一不登记；
 * - 上传/粘贴/拖拽：字节按 **4MB 分块**过 IPC（不存在整文件 base64），finish 后按 sha 登记；
 * - 取消：job id 原样送达后端。
 */
import { afterEach, describe, expect, it } from "vitest";
import { setFileInvoker } from "../core/file-api";
import {
  ingestFileBytes,
  ingestPastedImage,
} from "../core/document/client";
import {
  __resetDocumentBackendForTests,
  BLOB_CHUNK_BYTES,
  setDocumentBackend,
} from "../core/document/test-seams";
import { ingestDocumentPathsFromMessage } from "../core/document/ingest-from-message";
import {
  collectIndexablePaths,
  extractDocumentPaths,
  isDocumentExtension,
  stripCodeFromMessage,
} from "../core/document/path-ingest";
import { createFakeDocumentBackend } from "./helpers/documents-fake";

/** 最小 `File` 替身（happy-dom 的 File 在部分版本里没有可靠的 slice/arrayBuffer 组合）。 */
function makeFile(bytes: Uint8Array, name: string, type = "application/pdf"): File {
  return {
    name,
    type,
    size: bytes.length,
    slice(start: number, end: number) {
      const part = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
        },
      };
    },
  } as unknown as File;
}

afterEach(() => {
  __resetDocumentBackendForTests();
  setFileInvoker(null);
});

describe("DOCI-4 消息里的路径解析（保守，宁漏不错）", () => {
  it("识别绝对/相对/裸文件名，剔除 URL 与代码围栏", () => {
    const message = [
      "看下 C:\\资料\\报告.docx 和 docs/说明.md，还有 数据.xlsx",
      "```",
      "src/foo.pdf",
      "```",
      "参考 https://example.com/a.pdf 不算本地文件",
      "还有一个不存在的 exe：C:\\tools\\a.exe",
    ].join("\n");

    const cleaned = stripCodeFromMessage(message);
    expect(cleaned).not.toContain("src/foo.pdf"); // 围栏里的不当真
    const paths = extractDocumentPaths(cleaned);
    expect(paths).toContain("C:\\资料\\报告.docx");
    expect(paths).toContain("docs/说明.md");
    expect(paths).toContain("数据.xlsx");
    expect(paths.some((p) => p.includes("example.com"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".exe"))).toBe(false);
  });

  it("扩展名判定只认文档类型", () => {
    expect(isDocumentExtension("a.DOCX")).toBe(true);
    expect(isDocumentExtension("a.pdf")).toBe(true);
    expect(isDocumentExtension("a.exe")).toBe(false);
    expect(isDocumentExtension("noext")).toBe(false);
  });

  it("最多 20 条（防止一条消息把索引队列塞爆）", () => {
    const message = Array.from({ length: 40 }, (_, i) => `docs/f${i}.md`).join(" ");
    expect(extractDocumentPaths(message, 20)).toHaveLength(20);
  });

  it("存在性 + 允许根双重过滤", async () => {
    const existing = new Set(["c:\\project\\docs\\a.md", "c:\\project\\b.docx"]);
    const candidates = await collectIndexablePaths({
      message: "看 docs/a.md、b.docx 和 c.pdf",
      cwd: "C:\\project",
      exists: async (p) => existing.has(p.toLowerCase()),
      allowedRoots: ["C:\\project"],
    });
    expect(candidates.map((c) => c.raw)).toEqual(["docs/a.md", "b.docx"]);
    expect(candidates[0].path.toLowerCase()).toContain("c:\\project\\docs\\a.md");
  });

  it("允许根外的路径不登记（不索引用户没给的目录）", async () => {
    const candidates = await collectIndexablePaths({
      message: "看 C:\\其他\\秘密.docx",
      cwd: "C:\\project",
      exists: async () => true,
      allowedRoots: ["C:\\project"],
    });
    expect(candidates).toHaveLength(0);
  });
});

describe("DOCI-4 / DOCI-10 上传：4MB 分块（无整文件 base64）", () => {
  it("9.5MB 文件切成 4MB + 4MB + 1.5MB，并按 sha 登记", async () => {
    const fake = createFakeDocumentBackend();
    setDocumentBackend(fake.backend);
    const total = 9.5 * 1024 * 1024;
    const bytes = new Uint8Array(total);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;

    const progress: number[] = [];
    const result = await ingestFileBytes({
      collectionId: "p1",
      file: makeFile(bytes, "报告.pdf", "application/pdf"),
      kind: "attachment",
      sourceRef: "att-1",
      onProgress: (sent, all) => {
        expect(all).toBe(total);
        progress.push(sent);
      },
    });

    expect(fake.blobChunkBytes).toHaveLength(3);
    expect(fake.blobChunkBytes[0]).toBe(BLOB_CHUNK_BYTES);
    expect(fake.blobChunkBytes[1]).toBe(BLOB_CHUNK_BYTES);
    expect(fake.blobChunkBytes[2]).toBe(total - 2 * BLOB_CHUNK_BYTES);
    // 硬约束：任何单块都不许超过 4MB（整文件搬运会让 1GB 文件顶爆 IPC）
    for (const n of fake.blobChunkBytes) expect(n).toBeLessThanOrEqual(BLOB_CHUNK_BYTES);
    expect(progress).toEqual([BLOB_CHUNK_BYTES, 2 * BLOB_CHUNK_BYTES, total]);

    expect(result.sha256).toBe("f".repeat(64));
    expect(fake.ingests).toHaveLength(1);
    expect(fake.ingests[0]).toMatchObject({
      collection_id: "p1",
      kind: "attachment",
      sha256: "f".repeat(64),
      source_ref: "att-1",
      size: total,
    });
  });

  it("空文件也会 finish（不留下永久临时文件）", async () => {
    const fake = createFakeDocumentBackend();
    setDocumentBackend(fake.backend);
    await ingestFileBytes({ collectionId: "p1", file: makeFile(new Uint8Array(0), "空.txt", "text/plain") });
    expect(fake.blobChunkBytes).toEqual([0]);
    expect(fake.ingests[0].size).toBe(0);
  });
});

describe("DOCI-4 粘贴图片入索引", () => {
  it("data URL → blob → kind=paste（P0 只标 needs_ocr，由后端决定）", async () => {
    const fake = createFakeDocumentBackend();
    setDocumentBackend(fake.backend);
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==";
    const result = await ingestPastedImage({
      collectionId: "p1",
      dataUrl,
      name: "clipboard.png",
      sourceRef: "att-9",
    });
    expect(result?.sha256).toBe("f".repeat(64));
    expect(fake.ingests[0]).toMatchObject({ kind: "paste", source_ref: "att-9" });
    expect(fake.blobChunkBytes[0]).toBeGreaterThan(0);
  });

  it("坏 data URL 返回 null（不抛、不影响粘贴文字）", async () => {
    const fake = createFakeDocumentBackend();
    setDocumentBackend(fake.backend);
    const result = await ingestPastedImage({ collectionId: "p1", dataUrl: "not-a-data-url", name: "x.png" });
    expect(result).toBeNull();
    expect(fake.ingests).toHaveLength(0);
  });
});

describe("DOCI-4 消息入口接线（存在性通过文件层桩）", () => {
  it("只登记真实存在的那条，并对每条给出 job id", async () => {
    const fake = createFakeDocumentBackend();
    setDocumentBackend(fake.backend);
    setFileInvoker({
      async invoke(command: string, args?: Record<string, unknown>) {
        if (command === "path_exists") {
          const p = String(args?.path ?? "").toLowerCase();
          return p.endsWith("a.md") || p.endsWith("b.docx");
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const outcomes = await ingestDocumentPathsFromMessage({
      message: "看 docs/a.md、b.docx 和 c.pdf",
      cwd: "C:\\project",
      collectionId: "p1",
      allowedRoots: ["C:\\project"],
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => typeof o.jobId === "string")).toBe(true);
    expect(fake.ingests.map((i) => i.kind)).toEqual(["path", "path"]);
    expect(fake.ingests.map((i) => i.source_ref)).toEqual(["docs/a.md", "b.docx"]);
  });
});
