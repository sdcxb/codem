/**
 * 超大工具结果溢出（spill）+ 数据库维护 —— 对齐 DSH 的做法（第 76 波）
 *
 * 参考实现（本机 DSH 安装目录）：
 *   - `dsh-spill-policy`：超过 `maxInlineBytes` → 全文存会话私有文件，模型侧只留 head/tail 预览
 *     + 一行说明（省略了多少、全文在哪）；
 *   - `dsh-output-retention`：按**字节**计预算、head/tail 两端切分、**UTF-8 边界修剪**；
 *   - `dsh-atomic-write`：临时文件 + rename。
 *
 * Codem 这边的"本"是：本地 SQLite 整库常驻内存 + 只能整库导出，一次性大文本（构建日志、
 * 整文件 dump）会把库撑大，进而把每次保存的导出/编码峰值推爆渲染进程。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const fakeDb = {
    exec: vi.fn(() => []),
    run: vi.fn(),
    close: vi.fn(),
    export: vi.fn(() => new Uint8Array([1, 2, 3])),
  };
  return { fakeDb };
});

vi.mock("../core/file-api", () => ({
  getAppDataDir: vi.fn(async () => "C:\\appdata\\"),
  writeFile: vi.fn(async () => undefined),
  renameFile: vi.fn(async () => undefined),
  listDirectory: vi.fn(async () => []),
  deleteFile: vi.fn(async () => undefined),
}));

import { headTailPreview, retainToolResult, spillNotice, utf8Length, DEFAULT_MAX_INLINE_BYTES, pruneSpillFiles } from "../core/storage/spill";
import { getAppDataDir, writeFile, renameFile, listDirectory, deleteFile } from "../core/file-api";

const getAppDataDirMock = vi.mocked(getAppDataDir);
const writeFileMock = vi.mocked(writeFile);
const renameFileMock = vi.mocked(renameFile);
const listDirectoryMock = vi.mocked(listDirectory);
const deleteFileMock = vi.mocked(deleteFile);

beforeEach(() => {
  getAppDataDirMock.mockClear().mockResolvedValue("C:\\appdata\\");
  writeFileMock.mockClear().mockResolvedValue(undefined);
  renameFileMock.mockClear().mockResolvedValue(undefined);
  listDirectoryMock.mockClear().mockResolvedValue([]);
  deleteFileMock.mockClear().mockResolvedValue(undefined);
});

describe("超大工具结果溢出（DSH spill-policy 对齐）", () => {
  it("SPILL-1: 未超过上限时原样返回，且**不做任何 I/O**（常规结果零开销）", async () => {
    const small = "ok: build succeeded";
    const result = await retainToolResult(small, { sessionId: "s1", toolName: "bash", callId: "c1" });

    expect(result.spilled).toBe(false);
    expect(result.text).toBe(small);
    expect(result.omittedBytes).toBe(0);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(renameFileMock).not.toHaveBeenCalled();
  });

  it("SPILL-2: 超上限 → 预览 + 说明 + 全文落盘，且写盘是原子的（.tmp → rename）", async () => {
    const huge = "A".repeat(200 * 1024); // 200 KB
    const result = await retainToolResult(huge, { sessionId: "s1", toolName: "bash", callId: "call-42" });

    expect(result.spilled).toBe(true);
    expect(result.totalBytes).toBe(200 * 1024);
    expect(result.omittedBytes).toBeGreaterThan(0);
    // 预览 + 一行说明，体积远小于原文
    expect(utf8Length(result.text)).toBeLessThan(20 * 1024);
    expect(result.text).toContain("（中间省略）");
    expect(result.text).toContain("已省略");
    // 说明里必须能找回全文
    expect(result.locator).toContain("C:\\appdata\\spill\\s1\\");
    expect(result.locator).toMatch(/bash-call-42-\d{10,}\.txt$/);
    expect(result.text).toContain(result.locator);

    // 全文（不是预览）落盘，且走的是临时文件 + 改名
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [tmpPath, fullText] = writeFileMock.mock.calls[0];
    expect(tmpPath).toBe(`${result.locator}.tmp`);
    expect(fullText).toBe(huge);
    expect(renameFileMock).toHaveBeenCalledWith(`${result.locator}.tmp`, result.locator);
  });

  it("SPILL-3: 按字节计预算并在 UTF-8 边界修剪（中文/emoji 不会被切成半个字符）", async () => {
    const text = "中文内容🎯".repeat(5000); // 多字节字符 + 代理对
    const total = utf8Length(text);
    const { preview, omittedBytes, keptBytes } = headTailPreview(text, 4096);

    expect(keptBytes + omittedBytes).toBe(total);
    expect(utf8Length(preview)).toBeLessThanOrEqual(total - omittedBytes + 64); // 允许分隔符开销
    // 不能出现替换字符（半个多字节字符被解码的结果）
    expect(preview.includes("\uFFFD")).toBe(false);
    // 预览的首尾必须仍是合法整字符（不崩、不错位）
    expect(preview.startsWith("中")).toBe(true);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(preview.replace(/……（中间省略）……/g, "")))).not.toThrow();
  });

  it("SPILL-4: 说明行的措辞与 DSH 一致（省略多少 + 全文定位符）", () => {
    const notice = spillNotice(123456, "C:\\appdata\\spill\\s1\\bash-c1.txt");
    expect(notice).toContain("已省略 123456 字节");
    expect(notice).toContain("完整结果保存在：C:\\appdata\\spill\\s1\\bash-c1.txt");
  });

  it("SPILL-5: 上限可配置（默认 64 KB，可被调用方收紧/放宽）", async () => {
    expect(DEFAULT_MAX_INLINE_BYTES).toBe(64 * 1024);
    const text = "x".repeat(2048);
    expect((await retainToolResult(text, { maxInlineBytes: 1024 })).spilled).toBe(true);
    expect((await retainToolResult(text, { maxInlineBytes: 4096 })).spilled).toBe(false);
  });

  it("SPILL-6: 溢出文件名带时间戳，且过期文件会被清理（磁盘不能只涨不降）", async () => {
    const huge = "B".repeat(100 * 1024);
    const result = await retainToolResult(huge, { sessionId: "s2", toolName: "read", callId: "c9" });
    // 时间戳写在文件名里（list_directory 不回传 mtime，靠文件名判断不受拷贝影响）
    expect(result.locator).toMatch(/read-c9-\d{10,}\.txt$/);

    const now = Date.now();
    const oldFile = `${"C:\\appdata\\spill\\s2"}\\bash-c1-${now - 30 * 24 * 60 * 60 * 1000}.txt`;
    const freshFile = `${"C:\\appdata\\spill\\s2"}\\bash-c2-${now - 60 * 1000}.txt`;
    const tempFile = `${"C:\\appdata\\spill\\s2"}\\bash-c3-${now}.txt.tmp`;
    const foreignFile = `${"C:\\appdata\\spill\\s2"}\\notes.txt`; // 认不出来历的不该被删
    listDirectoryMock.mockImplementation(async (p: string) => {
      if (p === "C:\\appdata\\spill") {
        return [{ name: "s2", path: "C:\\appdata\\spill\\s2", isDirectory: true }];
      }
      return [
        { name: oldFile.split("\\").pop()!, path: oldFile, isDirectory: false },
        { name: freshFile.split("\\").pop()!, path: freshFile, isDirectory: false },
        { name: tempFile.split("\\").pop()!, path: tempFile, isDirectory: false },
        { name: "notes.txt", path: foreignFile, isDirectory: false },
      ];
    });

    const pruned = await pruneSpillFiles({ keepDays: 14, now });

    const deleted = deleteFileMock.mock.calls.map((c) => c[0]);
    expect(deleted).toContain(oldFile); // 超期 → 删
    expect(deleted).toContain(tempFile); // 崩溃残留的中间态 → 删
    expect(deleted).not.toContain(freshFile); // 保留期内 → 留
    expect(deleted).not.toContain(foreignFile); // 非本机制生成 → 不碰
    expect(pruned.deletedFiles).toBe(2);
  });
});
