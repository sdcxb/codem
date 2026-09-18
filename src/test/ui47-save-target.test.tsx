/**
 * 第 47 轮补：UI/UX 语义审计报出的"**保存到了错的地方**"两类缺陷的回归契约
 *
 * 这两条都属于最危险的一类 —— **静默写坏用户数据**：控件看起来正常工作、
 * 没有报错、短情况下完全正确，只有在特定数据形态下才写错目标。
 * 而它们共同的特征是"两处代码各自看起来都对"，所以必须用**行为**钉住。
 *
 * | 组 | 缺陷（改前） |
 * | --- | --- |
 * | `UI47-1` | 「分层配置」点第 2 个子目录，读到并**写回**的都是第 1 个（解析按类别名 `find` 第一个匹配） |
 * | `UI47-2` | 笔记反向链接导航到 B 之后点保存，**B 的正文被 A 的内容覆盖**（编辑缓冲只在挂载时播种） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ==========================================================================
// UI47-1：分层配置的子目录必须按身份解析
// ==========================================================================

describe("UI47-1：分层配置的子目录解析（写错文件的那一类）", () => {
  const level = (lvl: string, basePath: string, over: Record<string, unknown> = {}) => ({
    level: lvl,
    basePath,
    agents: "",
    soul: "",
    identity: { name: "", role: "" },
    user: { name: "", timezone: "" },
    tools: "",
    heartbeat: "",
    ...over,
  });

  /** 项目下有两个 `.codem-sub` 子目录 —— 这正是触发条件 */
  const twoSubfolders = () => [
    level("app", "C:/app"),
    level("project", "C:/proj"),
    level("subfolder", "C:/proj/A"),
    level("subfolder", "C:/proj/B"),
  ];

  it("选中 B 必须解析到 B（改前恒为 A，于是读的是 A 的内容、写的是 A 的文件）", async () => {
    const { resolveActiveLevel } = await import("../components/ConfigEditor");
    const levels = twoSubfolders() as any;

    const picked = resolveActiveLevel(levels, "subfolder", "C:/proj/B");

    expect(
      picked?.basePath,
      "必须按身份解析；改前 `find(l => l.level === 'subfolder')` 会返回 C:/proj/A",
    ).toBe("C:/proj/B");
  });

  it("选中 A 仍然解析到 A（方向相反的对照）", async () => {
    const { resolveActiveLevel } = await import("../components/ConfigEditor");
    const levels = twoSubfolders() as any;
    expect(resolveActiveLevel(levels, "subfolder", "C:/proj/A")?.basePath).toBe("C:/proj/A");
  });

  it("app / project 仍然按类别解析（这条路径本来是对的，不许被改坏）", async () => {
    const { resolveActiveLevel } = await import("../components/ConfigEditor");
    const levels = twoSubfolders() as any;
    expect(resolveActiveLevel(levels, "app", null)?.basePath).toBe("C:/app");
    expect(resolveActiveLevel(levels, "project", null)?.basePath).toBe("C:/proj");
  });

  it("还没选过子目录 / 选中的子目录已消失 → 回落第一条子目录（不是乱选）", async () => {
    const { resolveActiveLevel } = await import("../components/ConfigEditor");
    const levels = twoSubfolders() as any;
    expect(resolveActiveLevel(levels, "subfolder", null)?.basePath, "没选过 → 第一条").toBe("C:/proj/A");
    expect(
      resolveActiveLevel(levels, "subfolder", "C:/proj/GONE")?.basePath,
      "选的没影了 → 回落第一条，而不是返回 undefined 让调用方崩",
    ).toBe("C:/proj/A");
  });

  it("身份必须能区分两条子目录（高亮判定靠它，否则所有子目录按钮同时高亮）", async () => {
    const { levelIdentity } = await import("../components/ConfigEditor");
    const levels = twoSubfolders() as any;
    const ids = levels.map(levelIdentity);
    expect(new Set(ids).size, "四个层级必须有四个不同身份").toBe(4);
    expect(ids[2]).not.toBe(ids[3]);
  });
});

// ==========================================================================
// UI47-2：笔记编辑器换篇之后不许把旧缓冲写进新篇
// ==========================================================================

describe("UI47-2：笔记编辑器的缓冲归属（覆盖错笔记的那一类）", () => {
  /** 只测"缓冲跟着 note 走"这一件事：把 NoteEditor 的依赖全部打桩 */
  async function renderEditor(noteId: string, title: string, content: string) {
    vi.doMock("../core/knowledge/note-links", () => ({
      getIncomingLinks: () => [],
      getOutgoingLinks: () => [],
      syncNoteLinks: vi.fn(),
    }));
    vi.doMock("../core/storage/note-versions", () => ({
      saveNoteVersion: vi.fn(),
      listNoteVersions: () => [],
    }));
    const { NoteEditor } = await import("../components/NoteEditor");
    const onSave = vi.fn();
    const note = { id: noteId, title, content, tags: [], createdAt: 1, updatedAt: 1 } as any;
    const utils = render(
      React.createElement(NoteEditor, {
        note,
        notebookId: "nb1",
        onSave,
        onCancel: () => {},
      } as any),
    );
    return { ...utils, onSave };
  }

  it("切换到另一篇笔记后，标题/正文框必须显示**新那篇**的内容", async () => {
    const noteA = { id: "A", title: "笔记A标题", content: "A 的正文", tags: [], createdAt: 1, updatedAt: 1 };
    const noteB = { id: "B", title: "笔记B标题", content: "B 的正文", tags: [], createdAt: 2, updatedAt: 2 };

    vi.doMock("../core/knowledge/note-links", () => ({
      getIncomingLinks: () => [],
      getOutgoingLinks: () => [],
      syncNoteLinks: vi.fn(),
    }));
    vi.doMock("../core/storage/note-versions", () => ({ saveNoteVersion: vi.fn(), listNoteVersions: () => [] }));
    const { NoteEditor } = await import("../components/NoteEditor");

    const { rerender } = render(
      React.createElement(NoteEditor, { note: noteA, notebookId: "nb1", onSave: vi.fn(), onCancel: () => {} } as any),
    );

    // 断言前提：先看到 A
    expect((screen.getByDisplayValue("笔记A标题") as HTMLInputElement).value).toBe("笔记A标题");
    expect((screen.getByDisplayValue("A 的正文") as HTMLTextAreaElement).value).toBe("A 的正文");

    /*
     * 模拟"点反向链接跳到 B"：渲染处**不换 key**，只换 props
     * （`NotebookWorkspace` 就是这么渲染的）。
     *
     * 改前：三个 useState 只在挂载时播种 → 框里仍是 A 的文本，
     * 而保存用的是 `note.id`（已经是 B）→ **B 的正文被 A 的内容覆盖**。
     */
    rerender(
      React.createElement(NoteEditor, { note: noteB, notebookId: "nb1", onSave: vi.fn(), onCancel: () => {} } as any),
    );

    expect(
      (screen.getByDisplayValue("笔记B标题") as HTMLInputElement).value,
      "标题框必须换成 B 的（改前还是 A 的标题）",
    ).toBe("笔记B标题");
    expect(
      (screen.getByDisplayValue("B 的正文") as HTMLTextAreaElement).value,
      "正文框必须换成 B 的（改前还是 A 的正文 —— 一次保存就覆盖 B）",
    ).toBe("B 的正文");
  });

  it("同一篇笔记的 props 被外部更新时**不许**冲掉用户正在打的字", async () => {
    const noteA = { id: "A", title: "标题", content: "原始正文", tags: [], createdAt: 1, updatedAt: 1 };
    vi.doMock("../core/knowledge/note-links", () => ({
      getIncomingLinks: () => [],
      getOutgoingLinks: () => [],
      syncNoteLinks: vi.fn(),
    }));
    vi.doMock("../core/storage/note-versions", () => ({ saveNoteVersion: vi.fn(), listNoteVersions: () => [] }));
    const { NoteEditor } = await import("../components/NoteEditor");

    const { rerender } = render(
      React.createElement(NoteEditor, { note: noteA, notebookId: "nb1", onSave: vi.fn(), onCancel: () => {} } as any),
    );

    // 用户开始编辑
    const textarea = screen.getByDisplayValue("原始正文") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "用户正在打的字" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("用户正在打的字");

    /*
     * 外部把**同一篇**的 content 更新了（自动保存 / 别处编辑）。
     * 判据必须按 `id` 而不是按内容 —— 按内容的话这里会把用户的字冲掉。
     */
    rerender(
      React.createElement(NoteEditor, {
        note: { ...noteA, content: "外部改过的正文" },
        notebookId: "nb1",
        onSave: vi.fn(),
        onCancel: () => {},
      } as any),
    );

    expect(
      (screen.getByDisplayValue("用户正在打的字") as HTMLTextAreaElement).value,
      "同一篇笔记：外部更新不许覆盖用户正在输入的缓冲",
    ).toBe("用户正在打的字");
  });
});
