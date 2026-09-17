/**
 * 笔记双向链接：**保存后链接必须还在**（第 83 波审计修正）
 *
 * 真实缺陷：`syncNoteLinks` 里"删旧出链"用的是
 * `import('../storage/database').then(...)` —— 删除被排进**微任务**，
 * 必然排在同一次调用里**同步**执行的新链接插入**之后**：
 *
 *   保存一篇含 `[[目标笔记]]` 的笔记 → 先插入 N 条链接 → 紧接着微任务把 N 条全删掉
 *   → 反向链接面板**永远是空的**（函数却返回"创建了 N 条"）。
 *
 * 这条用例直接断言"保存后链接还在"，修复前必红。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") { files.set(args.path, args.content); return undefined; }
        if (cmd === "append_file") { files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n"); return undefined; }
        if (cmd === "read_file") { if (!files.has(args.path)) throw new Error("no such file"); return files.get(args.path); }
        if (cmd === "list_directory") return [];
        if (cmd === "delete_file") { files.delete(args.path); return undefined; }
        if (cmd === "rename_file") { const c = files.get(args.oldPath); files.delete(args.oldPath); if (c !== undefined) files.set(args.newPath, c); return undefined; }
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { createNotebook, createNote, addNoteLink, getBacklinks, getNoteLinks } from "../core/knowledge/storage";
import { syncNoteLinks } from "../core/knowledge/note-manager";

let NB = "nb-links-test";

/**
 * 夹具（第 18 轮，L1）：**端口基座**，不再初始化旧库。
 *
 * 原来这里 `await initDatabase()` + 三条裸 `DELETE FROM note_links/notes/notebooks`：
 * 那是"旧库是唯一数据源"（A 态）时代的清表夹具。A 态已删（`setup.ts` 每例注册一个
 * **全新**的内存假端口，端口即唯一数据源），清表因此不再需要 —— 每例的端口都是空的。
 *
 * `createNotebook` / `createNote` 走 `domainWrite`（端口），所以"先建笔记本"这一步
 * 依然必要，且现在落在端口镜像上（与产品同一条路）。
 */
beforeEach(() => {
  installFsStub();
  // createNote 会自己生成 id（忽略传入 id），并且 notebook_id 有外键约束 → 先建笔记本
  NB = createNotebook({ name: "链接测试笔记本" } as any).id;
});

afterEach(() => {
  delete (window as any).__TAURI__;
});

/** @returns 真正落库的笔记 id（createNote 自己生成 id） */
function makeNote(title: string, content: string): string {
  return createNote({ notebookId: NB, title, content } as any).id;
}

describe("笔记双向链接的写入顺序", () => {
  it("NL-1: 保存含 [[WikiLink]] 的笔记后，链接必须真的存在（修复前被微任务删空）", async () => {
    const targetId = makeNote("目标笔记", "我是被链接的目标");
    const sourceId = makeNote("来源笔记", "参见 [[目标笔记]] 的内容");

    const created = syncNoteLinks(sourceId, NB, "参见 [[目标笔记]] 的内容");
    // 让所有微任务/动态 import 都跑完（正是原来删链接的时机）
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(created, "解析出 1 条链接").toBeGreaterThanOrEqual(1);
    const links = getNoteLinks(sourceId);
    expect(links.map((l) => l.targetNoteId), "链接不该被删空（修复前这里会是 []）").toContain(targetId);
    const backlinks = getBacklinks(targetId);
    expect(backlinks.map((b) => b.sourceNoteId), "反向链接面板要能看到来源").toContain(sourceId);
  });

  it("NL-2: 重复保存时旧链接被替换（删旧在前、插新在后）", async () => {
    const t1 = makeNote("笔记一", "一");
    const t2 = makeNote("笔记二", "二");
    const src = makeNote("来源", "");
    const src2 = makeNote("另一来源", "");

    syncNoteLinks(src, NB, "[[笔记一]]");
    expect(getNoteLinks(src).map((l) => l.targetNoteId)).toEqual([t1]);

    // 改成链到笔记二：旧的必须消失、新的必须在
    syncNoteLinks(src, NB, "[[笔记二]]");
    expect(getNoteLinks(src).map((l) => l.targetNoteId)).toEqual([t2]);

    // 另一来源的链接不受影响（删除只按 source 精确匹配）
    addNoteLink(src2, t1, "笔记一");
    syncNoteLinks(src, NB, "[[笔记二]]");
    expect(getNoteLinks(src2).map((l) => l.targetNoteId)).toEqual([t1]);
  });
});
