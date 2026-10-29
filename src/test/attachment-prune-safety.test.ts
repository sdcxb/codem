/**
 * 孤儿附件清理：**空引用清单不许当"全是孤儿"**（第 233 轮审计 · P0 不可逆删除）。
 *
 * ## 触发现场（真实恢复路径，不是假设）
 *
 * 1. 库损坏 ⇒ 引擎 `open_with_recovery` 建空库并打「重建索引」标记；
 * 2. 重建只重放 messages / tool_calls（`repo.rs` `messages_rebuild_index`），**不重放 attachments**；
 * 3. 权威 JSONL 里 `attachmentsForLog` 刻意不写 `content` ⇒ `file:<路径>` 标记不在日志里，
 *    也没法从日志恢复；
 * 4. 同一轮维护里 `attachments.externalized` 正常返回 `{items: []}` ⇒ 上层判成"权威的空清单"
 *    ⇒ `referenced = ∅` ⇒ 清理函数把 `<dataRoot>/attachments/` 下**每一个**外置正文删掉。
 *
 * 全程只有一行日志，而那是大文档/图片正文的**唯一副本**。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | ATT-P1 | 引用清单为空、目录里有文件 ⇒ **一个都不许删**，并如实回报被跳过的数量与原因 |
 * | ATT-P2 | 引用清单非空 ⇒ 只删"确实没被引用"的（反向对照，清理功能不能失效） |
 * | ATT-P3 | `.tmp` 残留无论清单是否为空都要清（写盘中间产物） |
 * | ATT-P4 | 目录不存在 ⇒ 0 删除、不抛（首次启动） |
 *
 * 变异自证：去掉 `referencedPaths.size === 0` 的闸门 ⇒ ATT-P1 立刻红。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
  writeFile: vi.fn(),
  renameFile: vi.fn(),
  readFile: vi.fn(),
  resolveDataRoot: vi.fn(async () => ({ root: "C:\\data\\" })),
}));

vi.mock("../core/file-api", () => ({
  listDirectory: mocks.listDirectory,
  deleteFile: mocks.deleteFile,
  writeFile: mocks.writeFile,
  renameFile: mocks.renameFile,
  readFile: mocks.readFile,
}));

vi.mock("../core/storage/data-root", () => ({
  resolveDataRoot: mocks.resolveDataRoot,
}));

import { pruneOrphanAttachmentFiles } from "../core/storage/attachment-files";

const DIR = "C:\\data\\attachments\\";
const file = (name: string) => ({ name, path: DIR + name, isDirectory: false, size: 10 });

beforeEach(() => {
  mocks.listDirectory.mockReset();
  mocks.deleteFile.mockReset().mockResolvedValue(undefined);
});

describe("孤儿附件清理的安全闸门", () => {
  it("ATT-P1: 引用清单为空 + 目录里有文件 ⇒ 一个都不删，并回报原因", async () => {
    mocks.listDirectory.mockResolvedValue([file("a.txt"), file("b.png")]);
    const r = await pruneOrphanAttachmentFiles(new Set());
    expect(mocks.deleteFile, "空清单不许触发删除（会把重建后的唯一副本删掉）").not.toHaveBeenCalled();
    expect(r.deletedFiles).toBe(0);
    expect(r.skippedUnreferenced).toBe(2);
    expect(r.reason).toBe("no-references");
  });

  it("ATT-P2（反向对照）: 清单非空 ⇒ 只删没被引用的", async () => {
    mocks.listDirectory.mockResolvedValue([file("keep.txt"), file("orphan.bin")]);
    const r = await pruneOrphanAttachmentFiles(new Set([DIR + "keep.txt"]));
    expect(r.deletedFiles).toBe(1);
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile.mock.calls[0][0]).toBe(DIR + "orphan.bin");
  });

  it("ATT-P3: .tmp 残留始终清理（即使引用清单为空）", async () => {
    mocks.listDirectory.mockResolvedValue([file("x.tmp"), file("body.txt")]);
    const r = await pruneOrphanAttachmentFiles(new Set());
    expect(r.deletedFiles).toBe(1);
    expect(mocks.deleteFile.mock.calls[0][0]).toBe(DIR + "x.tmp");
    expect(r.skippedUnreferenced).toBe(1);
  });

  it("ATT-P4: 附件目录不存在 ⇒ 0 删除、不抛", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"));
    const r = await pruneOrphanAttachmentFiles(new Set());
    expect(r.deletedFiles).toBe(0);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });
});
