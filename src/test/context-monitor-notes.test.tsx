/**
 * P1-1 / 24 §9.4：**会话笔记在产品界面里可见、可编辑、可删除**。
 *
 * ## 为什么必须有这条
 *
 * 24 号文 §4.2 第 6 条要求笔记是「数据」而不是模型私有状态：完全隐藏的模型私有状态
 * 在出问题时无法复核。`ContextMonitor` 的「会话笔记」区用只读查询
 * `listThreadNotes` 渲染列表/全文；编辑与删除走数据层唯一的写入口
 * （`updateThreadNote` / `deleteThreadNote` ⇒ 确认落库）。
 *
 * ## 判据
 *
 * | id | 钉什么 | 变红方式 |
 * |---|---|---|
 * | UI-NOTE-1 | 没有笔记 ⇒ 明确空态（不是整块消失） | 删掉空态分支 ⇒ 本行红 |
 * | UI-NOTE-2 | 有笔记 ⇒ 最新在前，点开显示全文、再点收起 | 不渲染全文 / 展开状态恒 true ⇒ 本行红 |
 * | UI-NOTE-3 | 切换会话 ⇒ 上一个会话的笔记不残留 | 不按 sessionId 重读 ⇒ 本行红 |
 * | UI-NOTE-4 | 内联编辑：保存改正文/标签、updatedAt 变、清缓存后仍可读；取消不改 | 保存只 setState 不落库 / 取消也写入 ⇒ 本行红 |
 * | UI-NOTE-5 | 删除必须二次确认：第一下只进入确认态，确认后才真删 | 第一下就删 / 确认了不删 ⇒ 本行红 |
 * | UI-NOTE-6 | 失败可见：保存时 id 已被删 ⇒ 错误块显示原因，不是静默失败 | 吞掉错误 / 不显示错误块 ⇒ 本行红 |
 * | UI-NOTE-7 | 切会话清空编辑/确认/错误状态（不会把 A 的编辑存到 B） | 换会话不清编辑态 ⇒ 本行红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ContextMonitor } from "../components/ContextMonitor";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import {
  appendThreadNote,
  deleteThreadNote,
  forgetThreadNotes,
  listThreadNotes,
  readThreadNote,
  __resetThreadNotesCache,
} from "../core/context/thread-notes";

const SESSION_A = "cm-notes-a";
const SESSION_B = "cm-notes-b";

beforeEach(() => {
  setStoragePort(
    createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION_A, project_id: "", title: "A", created_at: 0, last_message_at: 0, message_count: 0 },
          { id: SESSION_B, project_id: "", title: "B", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
      },
    }),
  );
  __resetThreadNotesCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  forgetThreadNotes(SESSION_A);
  forgetThreadNotes(SESSION_B);
  __resetThreadNotesCache();
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("P1-1：ContextMonitor 会话笔记（可见 / 可编辑 / 可删除）", () => {
  it("UI-NOTE-1：没有笔记 ⇒ 明确空态（入口本身仍在）", async () => {
    render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-thread-notes")).toBeTruthy());
    expect(screen.getByTestId("context-thread-notes-empty").textContent).toContain("还没有会话笔记");
    expect(screen.queryAllByTestId("context-thread-note-row")).toHaveLength(0);
  });

  it("UI-NOTE-2：有笔记 ⇒ 最新在前；点开显示全文、再点收起", async () => {
    appendThreadNote(SESSION_A, { text: "目标：修 write 假成功", tag: "goal" });
    appendThreadNote(SESSION_A, { text: `卡点：${"很长的上下文描述".repeat(20)} END_OF_LONG_NOTE` });

    render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-thread-notes")).toBeTruthy());

    const rows = screen.getAllByTestId("context-thread-note-row");
    expect(rows, "两条笔记都要显示").toHaveLength(2);
    expect(rows[0].textContent, "最新一条在第一个").toContain("卡点：");
    expect(rows[1].textContent).toContain("目标：修 write 假成功");
    expect(rows[1].textContent).toContain("goal");

    /* 摘要行被截断；点开才显示全文（END_OF_LONG_NOTE 只能在全文里） */
    expect(screen.queryAllByTestId("context-thread-note-full")).toHaveLength(0);
    fireEvent.click(rows[0].querySelector("button")!);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-full")).toHaveLength(1));
    expect(screen.getByTestId("context-thread-note-full").textContent).toContain("END_OF_LONG_NOTE");

    fireEvent.click(rows[0].querySelector("button")!);
    await waitFor(() => expect(screen.queryAllByTestId("context-thread-note-full")).toHaveLength(0));
  });

  it("UI-NOTE-3：切换会话后不残留上一个会话的笔记（界面侧会话隔离）", async () => {
    appendThreadNote(SESSION_A, { text: "A 的目标" });
    const { rerender } = render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-thread-note-row")).toBeTruthy());
    expect(screen.getByTestId("context-thread-note-row").textContent).toContain("A 的目标");

    rerender(<ContextMonitor sessionId={SESSION_B} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-thread-notes-empty")).toBeTruthy());
    expect(screen.queryAllByTestId("context-thread-note-row")).toHaveLength(0);
  });

  it("UI-NOTE-4：内联编辑保存 ⇒ 正文/标签更新、updatedAt 变、清缓存（模拟重启）仍可读", async () => {
    appendThreadNote(SESSION_A, { text: "旧正文", tag: "goal" });
    const before = listThreadNotes(SESSION_A)[0];

    render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("context-thread-note-edit"));
    const textarea = screen.getByTestId("context-thread-note-textarea") as HTMLTextAreaElement;
    expect(textarea.value, "编辑框必须预填现有正文").toBe("旧正文");
    fireEvent.change(textarea, { target: { value: "新正文（已修正）" } });
    fireEvent.change(screen.getByTestId("context-thread-note-tag-input"), { target: { value: "progress" } });
    fireEvent.click(screen.getByTestId("context-thread-note-save"));

    await waitFor(() => expect(screen.queryByTestId("context-thread-note-editor")).toBeNull());
    const after = listThreadNotes(SESSION_A)[0];
    expect(after.text).toBe("新正文（已修正）");
    expect(after.tag).toBe("progress");
    expect(after.updatedAt, "编辑后 updatedAt 必须变（可见的改过证据）").toBeGreaterThan(before.updatedAt);
    expect(screen.getByTestId("context-thread-note-row").textContent).toContain("progress");

    /* 模拟重启：只留 settings 键 */
    __resetThreadNotesCache();
    expect(readThreadNote(SESSION_A, before.id)!.text, "编辑后重启仍可读").toBe("新正文（已修正）");
  });

  it("UI-NOTE-4b：取消编辑不改任何内容（编辑框关闭、正文保持旧值）", async () => {
    appendThreadNote(SESSION_A, { text: "不该被改掉" });
    render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("context-thread-note-edit"));
    fireEvent.change(screen.getByTestId("context-thread-note-textarea"), { target: { value: "取消掉的草稿" } });
    fireEvent.click(screen.getByTestId("context-thread-note-cancel"));

    await waitFor(() => expect(screen.queryByTestId("context-thread-note-editor")).toBeNull());
    expect(screen.getByTestId("context-thread-note-row").textContent).toContain("不该被改掉");
    expect(listThreadNotes(SESSION_A)[0].text, "取消不许落库").toBe("不该被改掉");
  });

  it("UI-NOTE-5：删除必须二次确认 —— 第一下只进确认态，确认后才真删", async () => {
    appendThreadNote(SESSION_A, { text: "要留的" });
    appendThreadNote(SESSION_A, { text: "要删的" });
    render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(2));

    /* 最新在前 ⇒ 第一行是「要删的」 */
    const row = screen.getAllByTestId("context-thread-note-row")[0];
    expect(row.textContent).toContain("要删的");
    fireEvent.click(within(row).getByTestId("context-thread-note-delete"));
    await waitFor(() => expect(screen.getByTestId("context-thread-note-delete-confirm")).toBeTruthy());
    expect(screen.getAllByTestId("context-thread-note-row"), "第一下不许真删").toHaveLength(2);
    expect(listThreadNotes(SESSION_A)).toHaveLength(2);

    fireEvent.click(screen.getByTestId("context-thread-note-delete-confirm-no"));
    await waitFor(() => expect(screen.queryByTestId("context-thread-note-delete-confirm")).toBeNull());
    expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(2);

    fireEvent.click(within(screen.getAllByTestId("context-thread-note-row")[0]).getByTestId("context-thread-note-delete"));
    fireEvent.click(await screen.findByTestId("context-thread-note-delete-confirm-yes"));
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(1));
    expect(listThreadNotes(SESSION_A).map((note) => note.text)).toEqual(["要留的"]);

    /* 重启后也不复活 */
    __resetThreadNotesCache();
    expect(listThreadNotes(SESSION_A).map((note) => note.text)).toEqual(["要留的"]);
  });

  it("UI-NOTE-6：保存失败要可见 —— id 已被删（外部/另一处）⇒ 错误块显示原因，不是静默失败", async () => {
    appendThreadNote(SESSION_A, { text: "稍后会被删掉" });
    render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("context-thread-note-edit"));
    const id = listThreadNotes(SESSION_A)[0].id;
    /* 模拟"另一处已经删掉了这条"：保存时目标已不存在 */
    expect(deleteThreadNote(SESSION_A, id).ok).toBe(true);
    fireEvent.click(screen.getByTestId("context-thread-note-save"));

    const error = await screen.findByTestId("context-thread-notes-error");
    expect(error.textContent).toContain("找不到");
    expect(error.textContent).toContain("会话隔离");
    /* 列表按权威读数刷新：已删除的那条不再显示 */
    await waitFor(() => expect(screen.queryAllByTestId("context-thread-note-row")).toHaveLength(0));
  });

  it("UI-NOTE-7：切会话清空编辑/确认/错误状态（A 的编辑不会带到 B）", async () => {
    appendThreadNote(SESSION_A, { text: "A 的笔记" });
    const { rerender } = render(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("context-thread-note-edit"));
    fireEvent.change(screen.getByTestId("context-thread-note-textarea"), { target: { value: "A 的未保存草稿" } });

    rerender(<ContextMonitor sessionId={SESSION_B} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-thread-notes-empty")).toBeTruthy());
    expect(screen.queryByTestId("context-thread-note-editor"), "换会话必须清空编辑态").toBeNull();
    expect(screen.queryByTestId("context-thread-notes-error")).toBeNull();

    rerender(<ContextMonitor sessionId={SESSION_A} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-thread-note-row")).toHaveLength(1));
    expect(screen.queryByTestId("context-thread-note-editor"), "回到 A 也不该恢复草稿编辑态").toBeNull();
    expect(listThreadNotes(SESSION_A)[0].text, "未保存草稿不许偷偷落库").toBe("A 的笔记");
  });
});
