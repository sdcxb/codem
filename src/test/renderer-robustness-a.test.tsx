/**
 * 渲染层健壮性回归（A 组）—— P0-3 / P1-9 / P1-10 / P1-11
 *
 * 覆盖项与"改前会红"的机制：
 * - RA-1 (P0-3)：FileEditor 切换文件必须重置内容/脏标记；读取未完成或失败时**禁止保存**，
 *   否则会把 A 文件的文本写进 B 文件的路径（真落盘、不可撤销）。
 *   改前：`content` state 在 filePath 变化时**不重置**，`modified` 仍是 true，
 *   保存按钮可点 → 把 A 的正文写到 B 的路径。
 * - RA-2 (P0-3)：RightSidebar 必须用 `key={editingFile}` 隔离 FileEditor 实例。
 *   改前：`<FileEditor filePath={...} />` 没有 key → 组件实例复用、内部 state 不重置。
 * - RA-3 (P1-9)：Excel/CSV 预览有明确行数上限 + 截断提示；小文件渲染结果不变。
 *   改前：`sheet.data.map(...)` 全量渲染（5 万行 × 20 列 ≈ 数百万 DOM 节点）。
 * - RA-4 (P1-10)：面板拖拽释放逻辑收敛到幂等 `endResize()`，pointerup / pointercancel /
 *   window.blur / 卸载都要摘掉 `body.resizing-columns`。
 *   改前：只监听 `pointerup` → 手势以 pointercancel / 失焦结束时 class 永久残留，
 *   而 `body.resizing-columns * { pointer-events: none !important }` 会让整个界面不可点击。
 * - RA-5 (P1-11)：useDraftPersistence 卸载/切换会话要**立即冲刷**待写草稿。
 *   改前：防抖 clearTimeout 直接丢弃最后一次输入（切换会话即丢字）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act, renderHook, waitFor } from "@testing-library/react";
import fs from "node:fs";
import React from "react";

// ==================== 桩：xlsx（避免真实解析，也让大表可控） ====================

const xlsxState: { rows: (string | number)[][] } = { rows: [] };

vi.mock("xlsx", () => ({
  read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }),
  utils: {
    sheet_to_json: () => xlsxState.rows.map((r) => [...r]),
  },
}));

// ==================== 桩：Tauri 文件读写 ====================

type ReadBehavior =
  | { kind: "ok"; content: string }
  | { kind: "error"; message: string }
  | { kind: "pending" };

const fileState = {
  reads: {} as Record<string, ReadBehavior>,
  /** 每次 invoke("read_file") 的记录 */
  readCalls: [] as string[],
  /** 每次 invoke("write_file") 的记录 */
  writes: [] as Array<{ path: string; content: string }>,
};

function invokeStub(cmd: string, args: any): Promise<any> {
  if (cmd === "read_file") {
    fileState.readCalls.push(String(args?.path));
    const behavior = fileState.reads[String(args?.path)];
    if (!behavior) return Promise.reject(new Error(`no stub for ${args?.path}`));
    if (behavior.kind === "ok") return Promise.resolve(behavior.content);
    if (behavior.kind === "error") return Promise.reject(new Error(behavior.message));
    return new Promise(() => {}); // pending：永不 settle（模拟"还在读 / 读取卡住"）
  }
  if (cmd === "write_file") {
    fileState.writes.push({ path: String(args?.path), content: String(args?.content) });
    return Promise.resolve(null);
  }
  return Promise.resolve(null);
}

import { FileEditor } from "../components/FileEditor";
import { usePaneResize } from "../hooks/usePaneResize";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { getSetting, setSetting } from "../core/storage/settings";
import { getStoragePort } from "../core/storage/port";

const FILE_A = "C:\\proj\\a.txt";
const FILE_B = "C:\\proj\\b.txt";

beforeEach(() => {
  fileState.reads = {};
  fileState.readCalls = [];
  fileState.writes = [];
  xlsxState.rows = [];
  (window as any).__TAURI__ = { core: { invoke: vi.fn(invokeStub) } };
  document.body.className = "";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
  document.body.className = "";
});

/** 文本域（代码编辑器） */
function textarea(): HTMLTextAreaElement | null {
  return document.querySelector("textarea.code-editor-textarea");
}

/** 保存按钮 */
function saveButton(): HTMLButtonElement {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes("保存"),
  ) as HTMLButtonElement;
}

/** 渲染 A（读完 + 编辑成脏）→ 切到 B（B 的读取行为由调用方设定） */
async function renderAEditedThenSwitchToB(
  bBehavior: ReadBehavior,
): Promise<{ switchTo: (p: string) => void }> {
  fileState.reads[FILE_A] = { kind: "ok", content: "AAA file A v1" };
  fileState.reads[FILE_B] = bBehavior;

  const onClose = () => {};
  const { rerender } = render(<FileEditor filePath={FILE_A} onClose={onClose} />);
  await waitFor(() => {
    expect(textarea()?.value).toBe("AAA file A v1");
  });
  fireEvent.change(textarea()!, { target: { value: "AAA file A EDITED" } });
  expect(saveButton().disabled).toBe(false);

  const switchTo = (p: string) => {
    act(() => {
      rerender(<FileEditor filePath={p} onClose={onClose} />);
    });
  };
  return { switchTo };
}

// ==================== RA-1 / RA-2：P0-3 跨文件数据覆盖 ====================

describe("P0-3 FileEditor 切换文件不得把 A 的正文写进 B", () => {
  it("RA-1a: 切到 B（读取未完成）→ 立即清空正文与脏标记，保存按钮禁用", async () => {
    const { switchTo } = await renderAEditedThenSwitchToB({ kind: "pending" });
    switchTo(FILE_B);

    const ta = textarea();
    expect(ta?.value ?? "").not.toBe("AAA file A EDITED");
    expect(ta?.value ?? "").not.toBe("AAA file A v1");
    expect(document.body.textContent).not.toContain("AAA file A EDITED");
    expect(saveButton().disabled).toBe(true);
  });

  it("RA-1b: 读取未完成时点保存 → 一次 write_file 都不能发生（不写 B、不写 A）", async () => {
    const { switchTo } = await renderAEditedThenSwitchToB({ kind: "pending" });
    switchTo(FILE_B);
    fireEvent.click(saveButton());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fileState.writes).toEqual([]);
  });

  it("RA-1c: B 读取失败 → 保存被禁止 + 可见错误提示（不得静默）", async () => {
    const { switchTo } = await renderAEditedThenSwitchToB({
      kind: "error",
      message: "EACCES: permission denied",
    });
    switchTo(FILE_B);
    await waitFor(() => {
      expect(document.body.textContent).toContain("EACCES: permission denied");
    });
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(saveButton());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fileState.writes).toEqual([]);
  });

  it("RA-1d: 读到 B 之后保存 → 写出的路径与内容都属于 B", async () => {
    const { switchTo } = await renderAEditedThenSwitchToB({ kind: "ok", content: "BBB file B v1" });
    switchTo(FILE_B);
    await waitFor(() => {
      expect(textarea()?.value).toBe("BBB file B v1");
    });

    fireEvent.change(textarea()!, { target: { value: "BBB file B EDITED" } });
    expect(saveButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(fileState.writes).toEqual([{ path: FILE_B, content: "BBB file B EDITED" }]);
    expect(fileState.writes[0].content).not.toContain("AAA");
    expect(fileState.writes[0].path).toBe(FILE_B);
  });

  it("RA-1e: 切换文件必须清掉旧内容并给出加载反馈", async () => {
    const { switchTo } = await renderAEditedThenSwitchToB({ kind: "pending" });
    switchTo(FILE_B);
    expect(document.body.textContent).not.toContain("AAA file A v1");
    expect(document.body.textContent).toMatch(/加载中/);
  });

  it("RA-2: RightSidebar 给 FileEditor 传 key={编辑中的文件路径}（实例隔离）", () => {
    const src = fs.readFileSync("src/components/RightSidebar.tsx", "utf8");
    expect(src).toMatch(/<FileEditor[\s\S]{0,200}?key=\{/);
  });
});

// ==================== RA-3：P1-9 表格预览上限 ====================

describe("P1-9 Excel/CSV 预览行数上限", () => {
  const EXCEL_FILE = "C:\\proj\\big.xlsx";
  const SMALL_FILE = "C:\\proj\\small.xlsx";

  function rowsRendered(): number {
    return document.querySelectorAll(".file-preview-excel-body tbody tr").length;
  }

  it("RA-3a: 超限时渲染行数 == 上限，且出现截断提示（含总行数）", async () => {
    fileState.reads[EXCEL_FILE] = { kind: "ok", content: "Zm9v" };
    xlsxState.rows = Array.from({ length: 50_000 }, (_, i) => [`r${i}`, `c${i}`]);

    render(<FileEditor filePath={EXCEL_FILE} onClose={() => {}} />);
    await waitFor(() => {
      expect(document.querySelector(".file-preview-excel-body")).toBeTruthy();
    });

    expect(rowsRendered()).toBe(500);
    const footer = document.querySelector(".file-preview-excel-footer")?.textContent ?? "";
    expect(footer).toMatch(/截断/);
    expect(footer).toContain("50000");
  });

  it("RA-3b: 未超限的小表 → 渲染结果与原来完全一致（无截断提示）", async () => {
    fileState.reads[SMALL_FILE] = { kind: "ok", content: "Zm9v" };
    xlsxState.rows = [
      ["h1", "h2"],
      ["a", "b"],
      ["c", "d"],
    ];

    render(<FileEditor filePath={SMALL_FILE} onClose={() => {}} />);
    await waitFor(() => {
      expect(document.querySelector(".file-preview-excel-body")).toBeTruthy();
    });

    expect(rowsRendered()).toBe(3);
    const table = document.querySelector(".file-preview-excel-body table") as HTMLTableElement;
    expect(table.querySelectorAll("tr")[0].className).toBe("header-row");
    expect(table.querySelectorAll("td")[0].className).toBe("row-num");
    expect(
      Array.from(table.querySelectorAll("tbody tr")[1].querySelectorAll("td")).map(
        (td) => td.textContent,
      ),
    ).toEqual(["2", "a", "b"]);
    const footer = document.querySelector(".file-preview-excel-footer")?.textContent ?? "";
    expect(footer).not.toMatch(/截断/);
    expect(footer).toContain("3");
  });
});

// ==================== RA-4：P1-10 拖拽释放 ====================

/**
 * 面板宽度的落盘判据（第 45 轮 D-22）。
 *
 * 这一组原来断言 `localStorage.getItem(storageKey)`；D-22 把 `usePaneResize` 的介质
 * 从 localStorage 收敛到配置面（DB `settings` 表）——与 `codem-sidebar-width` 同介质
 * ——所以断言改成读配置面（测试基座提供的假端口）。
 * 旧 localStorage 值的**迁移**路径由 `settings-tail-fixes.test.ts` 的
 * SKEY-D22-2 专门守着。
 */
function storedPaneWidth(key: string): string | null {
  return (getStoragePort().config.get<string | null>(key, null) as string | null) ?? null;
}

describe("P1-10 usePaneResize 释放逻辑", () => {
  function startResize(hook: { current: { onResizeStart: (e: any) => void } }, clientX = 100) {
    act(() => {
      hook.current.onResizeStart({
        clientX,
        preventDefault() {},
        stopPropagation() {},
      } as unknown as React.PointerEvent);
    });
  }

  it("RA-4a: 按下后 body 带 resizing-columns；pointerup 后摘掉并写入最终宽度", () => {
    localStorage.removeItem("test-pane-width-a");
    const { result, unmount } = renderHook(() =>
      usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "test-pane-width-a" }),
    );
    startResize(result);
    expect(document.body.classList.contains("resizing-columns")).toBe(true);

    act(() => {
      document.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 80 }));
    });
    expect(document.body.classList.contains("resizing-columns")).toBe(false);
    expect(storedPaneWidth("test-pane-width-a")).toBe("440");
    unmount();
  });

  it("RA-4b: pointercancel 结束手势 → body 不再带 resizing-columns（且幂等）", () => {
    localStorage.removeItem("test-pane-width-b");
    const { result, unmount } = renderHook(() =>
      usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "test-pane-width-b" }),
    );
    startResize(result);
    expect(document.body.classList.contains("resizing-columns")).toBe(true);

    act(() => {
      document.dispatchEvent(new window.PointerEvent("pointercancel", { clientX: 100 }));
    });
    expect(document.body.classList.contains("resizing-columns")).toBe(false);

    // 幂等：重复结束手势不能抛错、也不能让 class 复活
    act(() => {
      document.dispatchEvent(new window.PointerEvent("pointercancel", { clientX: 100 }));
      document.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 100 }));
    });
    expect(document.body.classList.contains("resizing-columns")).toBe(false);
    unmount();
  });

  it("RA-4c: 窗口失焦（window.blur）结束手势 → body 不再带 resizing-columns", () => {
    localStorage.removeItem("test-pane-width-c");
    const { result, unmount } = renderHook(() =>
      usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "test-pane-width-c" }),
    );
    startResize(result);
    expect(document.body.classList.contains("resizing-columns")).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(document.body.classList.contains("resizing-columns")).toBe(false);
    unmount();
  });

  it("RA-4d: 卸载时摘掉 class 与全部手势监听器", () => {
    localStorage.removeItem("test-pane-width-d");
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const winAddSpy = vi.spyOn(window, "addEventListener");
    const winRemoveSpy = vi.spyOn(window, "removeEventListener");
    const GESTURE = ["pointermove", "pointerup", "pointercancel"];

    const { result, unmount } = renderHook(() =>
      usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "test-pane-width-d" }),
    );
    startResize(result);
    expect(document.body.classList.contains("resizing-columns")).toBe(true);

    act(() => {
      unmount();
    });

    expect(document.body.classList.contains("resizing-columns")).toBe(false);

    const added = addSpy.mock.calls.map((c) => c[0] as string).filter((t) => GESTURE.includes(t));
    const removed = removeSpy.mock.calls.map((c) => c[0] as string).filter((t) => GESTURE.includes(t));
    expect(added).toContain("pointermove");
    // 注册过的手势监听器必须全部被摘掉
    for (const type of new Set(added)) {
      expect(removed).toContain(type);
    }
    const winAdded = winAddSpy.mock.calls.map((c) => c[0] as string);
    const winRemoved = winRemoveSpy.mock.calls.map((c) => c[0] as string);
    if (winAdded.includes("blur")) expect(winRemoved).toContain("blur");
  });

  it("RA-4e: 手势中途卸载（拖拽未松手时组件消失）→ class 摘掉 + 宽度落盘", () => {
    localStorage.removeItem("test-pane-width-e");
    const { result, unmount } = renderHook(() =>
      usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "test-pane-width-e" }),
    );
    startResize(result, 100);
    // 拖动到 x=40（向左 60 → 480）但**不松手**就卸载
    act(() => {
      document.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 40 }));
    });
    act(() => {
      unmount();
    });
    expect(document.body.classList.contains("resizing-columns")).toBe(false);
    expect(storedPaneWidth("test-pane-width-e")).toBe("480");
  });

  it("RA-4f: 真实接线（pointerdown 事件 → 拖动 → pointerup）宽度正确且 class 被摘掉", () => {
    localStorage.removeItem("test-pane-width-f");
    const { result, unmount } = renderHook(() =>
      usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "test-pane-width-f" }),
    );
    const handle = document.createElement("div");
    handle.className = "right-sidebar-resize-handle";
    handle.addEventListener("pointerdown", result.current.onResizeStart as unknown as EventListener);
    document.body.appendChild(handle);

    fireEvent.pointerDown(handle, { clientX: 100 });
    expect(document.body.classList.contains("resizing-columns")).toBe(true);
    fireEvent.pointerMove(document, { clientX: 60 });
    fireEvent.pointerUp(document, { clientX: 60 });
    expect(document.body.classList.contains("resizing-columns")).toBe(false);
    // 向左 40 → 420 + 40 = 460
    expect(result.current.width).toBe(460);
    expect(storedPaneWidth("test-pane-width-f")).toBe("460");
    document.body.removeChild(handle);
    unmount();
  });
});

// ==================== RA-5：P1-11 草稿冲刷 ====================

describe("P1-11 useDraftPersistence 卸载/切换冲刷", () => {
  it("RA-5a: 输入后立刻卸载 → 草稿已经写入（不等 500ms）", () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useDraftPersistence("sess-1"));
      act(() => {
        result.current.setDraft("未发送的输入");
      });
      // 防抖窗口内直接卸载（模拟切换会话/关闭输入框）
      unmount();
      expect(getSetting("composer-draft-sess-1")).toBe("未发送的输入");
    } finally {
      vi.useRealTimers();
    }
  });

  it("RA-5b: 卸载后不再 setState（无 React 告警）；重新挂载能读回草稿", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = renderHook(() => useDraftPersistence("sess-2"));
      act(() => {
        first.result.current.setDraft("草稿内容 v2");
      });
      first.unmount();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    const second = renderHook(() => useDraftPersistence("sess-2"));
    await waitFor(() => {
      expect(second.result.current.draft).toBe("草稿内容 v2");
    });
    second.unmount();
  });

  it("RA-5c: 切换会话时旧会话草稿被冲刷、新会话草稿独立", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ k }: { k: string }) => useDraftPersistence(k),
        { initialProps: { k: "sess-old" } },
      );
      act(() => {
        result.current.setDraft("old 会话草稿");
      });
      act(() => {
        rerender({ k: "sess-new" });
      });
      expect(getSetting("composer-draft-sess-old")).toBe("old 会话草稿");

      act(() => {
        result.current.setDraft("new 会话草稿");
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(getSetting("composer-draft-sess-new")).toBe("new 会话草稿");
      // 旧键不能被新会话的文本覆写
      expect(getSetting("composer-draft-sess-old")).toBe("old 会话草稿");
    } finally {
      vi.useRealTimers();
    }
  });

  it("RA-5d: 切换会话不得把旧会话的文本写进新会话的键（草稿不许串会话）", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ k }: { k: string }) => useDraftPersistence(k),
        { initialProps: { k: "sess-x" } },
      );
      act(() => {
        result.current.setDraft("X 会话的未发送文本");
      });
      act(() => {
        rerender({ k: "sess-y" });
      });
      // 冲刷只能是"写回 X 自己的键"，绝不能把 X 的文本写进 Y 的键
      expect(getSetting("composer-draft-sess-x")).toBe("X 会话的未发送文本");
      expect(getSetting("composer-draft-sess-y")).toBeNull();
      expect(result.current.draft).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("RA-5e: 切到已有草稿的会话 → 读到的是**这个会话自己的**草稿", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ k }: { k: string }) => useDraftPersistence(k),
        { initialProps: { k: "sess-p" } },
      );
      act(() => {
        result.current.setDraft("P 的草稿");
      });
      act(() => {
        vi.advanceTimersByTime(600); // 让 P 的草稿落盘
      });
      // 预置 Q 的草稿（模拟"Q 之前已经输入过"）
      setSetting("composer-draft-sess-q", "Q 的既有草稿");

      act(() => {
        rerender({ k: "sess-q" });
      });
      // 必须读回 Q 自己的草稿，且不能被 P 的文本覆盖
      expect(result.current.draft).toBe("Q 的既有草稿");
      expect(getSetting("composer-draft-sess-q")).toBe("Q 的既有草稿");
      expect(getSetting("composer-draft-sess-p")).toBe("P 的草稿");
    } finally {
      vi.useRealTimers();
    }
  });

  it("RA-5f（第 54 轮）: 只是**路过**一个会话（一个字没敲、待满防抖窗口）→ 不许留下空草稿行", () => {
    /**
     * 真机实证的偏差：`settings` 里有 24 条 `composer-draft-*`，一部分的会话早就删了、
     * 值全是空串 —— 成因就是防抖定时器**无条件**写。文件里的注释一直写着
     * "遍历过的会话不该攒出无意义的行"，实现却是相反的。
     */
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useDraftPersistence("sess-visit"));
      act(() => {
        vi.advanceTimersByTime(5000); // 远远超过 500ms 防抖窗口
      });
      expect(
        getSetting("composer-draft-sess-visit"),
        "没敲过字的会话不该有一行草稿（空串不是信息）",
      ).toBeNull();
      unmount();
      expect(getSetting("composer-draft-sess-visit")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("RA-5g（第 54 轮）: 把输入框删空 → 那一行**被删掉**（不是留一条空串）", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useDraftPersistence("sess-clear"));
      act(() => {
        result.current.setDraft("打了一半又想删掉");
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(getSetting("composer-draft-sess-clear")).toBe("打了一半又想删掉");

      act(() => {
        result.current.setDraft("");
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(
        getSetting("composer-draft-sess-clear"),
        "不变量：`composer-draft-<key>` 存在 ⇔ 有一份**非空**草稿",
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("RA-5h（第 54 轮）: `clearDraft`（发完消息）→ 行被删掉，之后重新挂载读回空草稿", () => {
    vi.useFakeTimers();
    try {
      const first = renderHook(() => useDraftPersistence("sess-sent"));
      act(() => {
        first.result.current.setDraft("这条要发出去");
      });
      act(() => {
        first.result.current.clearDraft();
      });
      expect(getSetting("composer-draft-sess-sent"), "发出去了就不该留草稿行").toBeNull();
      first.unmount();

      const second = renderHook(() => useDraftPersistence("sess-sent"));
      expect(second.result.current.draft).toBe("");
      second.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
