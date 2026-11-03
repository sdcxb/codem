/**
 * 共享变更列表判据（CHG-UI-1..9，第 270 波）。
 *
 * 桌面 Inspector 的 INV-1..4 仍然走**真实适配器**（`src/components/FileChangesList`）；
 * 这里钉共享层自身的语义：四种空态互不冒充、缺统计显示 `—`、能力位为 false 时
 * 控件**不出现**、最近一轮按 `createdAt` 而不是 `turnIndex`、分页只追加不重置。
 */
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChangesList } from "../../packages/ui/src/changes-list";
import { SessionChangesPane } from "../../packages/ui/src/changes-pane";
import type { TurnChangesView } from "../../packages/protocol/src/index";

function change(over: Partial<TurnChangesView> = {}): TurnChangesView {
  return {
    changeId: "tfc-1",
    messageId: "m-1",
    turnIndex: 3,
    createdAt: 1_700_000_000_000,
    status: "completed",
    treesAvailable: true,
    files: [
      { path: "src/a.ts", status: "M", additions: 12, deletions: 3 },
      { path: "assets/logo.bin", status: "A" },
    ],
    totals: { additions: 12, deletions: 3 },
    ...over,
  };
}

function renderList(over: Partial<ComponentProps<typeof ChangesList>> = {}) {
  return render(
    <ChangesList
      records={[]}
      capabilities={{ revert: true, checks: true }}
      {...over}
    />,
  );
}

afterEach(() => cleanup());

describe("CHG-UI-1 四种空态互不冒充", () => {
  it("读取中", () => {
    renderList({ loading: true });
    expect(screen.getByText("读取中…")).toBeTruthy();
    expect(screen.queryByText("暂无文件变更记录")).toBeNull();
  });

  it("读取失败（显示错误原文，不画成没有记录）", () => {
    renderList({ error: "端口未注册" });
    expect(screen.getByText("文件变更记录读取失败")).toBeTruthy();
    expect(screen.getByText("端口未注册")).toBeTruthy();
    expect(screen.queryByText("暂无文件变更记录")).toBeNull();
  });

  it("Host 不支持（显示原因，不画成读取失败）", () => {
    renderList({ supported: false, reason: "不是 git 仓库" });
    expect(screen.getByText("此 Host 不记录文件变更")).toBeTruthy();
    expect(screen.getByText("不是 git 仓库")).toBeTruthy();
    expect(screen.queryByText("文件变更记录读取失败")).toBeNull();
  });

  it("真的没有记录", () => {
    renderList();
    expect(screen.getByText("暂无文件变更记录")).toBeTruthy();
    expect(screen.getByText("Agent 执行修改后会自动记录")).toBeTruthy();
  });
});

describe("CHG-UI-2 缺统计显示 —（不是 0）", () => {
  it("缺 numstat 的文件行显示 +— / −—；totals 缺席时汇总也显示 +— −—", () => {
    const record = change({ totals: undefined });
    const { container } = renderList({ records: [record] });
    const rows = [...container.querySelectorAll(".inspector-file-row")];
    const bin = rows.find((r) => (r.textContent ?? "").includes("assets/logo.bin"))!;
    expect(bin.textContent).toContain("+—");
    expect(bin.textContent).toContain("−—");
    expect(bin.textContent).not.toContain("+0");

    const head = container.querySelector(".inspector-latest-head")!;
    expect(head.textContent).toContain("+—");
    expect(head.textContent).toContain("−—");
    expect(head.textContent).not.toContain("+0");
  });
});

describe("CHG-UI-3 能力位是数据：revert=false ⇒ 按钮不出现", () => {
  it("capabilities.revert=false 时没有回滚按钮（不是禁用按钮）", () => {
    renderList({ records: [change()], capabilities: { revert: false, checks: false } });
    expect(document.querySelector(".revert-btn")).toBeNull();
    expect(screen.queryByText("回滚本轮")).toBeNull();
  });

  it("revert=true 时出现，且回调拿到这一条记录", () => {
    const onRevert = vi.fn();
    renderList({ records: [change()], onRevert });
    const btn = screen.getByText("回滚本轮");
    fireEvent.click(btn);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert.mock.calls[0][0].changeId).toBe("tfc-1");
  });
});

describe("CHG-UI-4 最近一轮按 createdAt，而不是 turnIndex", () => {
  it("新 prompt 的 turn_index 更小，仍显示为最近一轮", () => {
    const old = change({
      changeId: "old",
      turnIndex: 300,
      createdAt: 1_000,
      files: [{ path: "old.ts", status: "M" }],
    });
    const fresh = change({
      changeId: "fresh",
      turnIndex: 1,
      createdAt: 9_999,
      files: [{ path: "fresh.ts", status: "M" }],
    });
    const { container } = renderList({ records: [old, fresh] });
    const latest = container.querySelector(".inspector-latest")!;
    expect(latest.textContent, "最近一轮必须是时间更新的那条").toContain("fresh.ts");
    expect(latest.textContent).not.toContain("old.ts");
    expect(container.querySelector(".inspector-history-title")?.textContent).toBe("历史轮次");
  });
});

describe("CHG-UI-5 checks 区块只在能力位为 true 时出现", () => {
  it("capabilities.checks=false ⇒ 整个区块不出现（不是空块）", () => {
    const { container } = renderList({ records: [change()], capabilities: { revert: false, checks: false } });
    expect(container.querySelector(".inspector-checks")).toBeNull();
  });

  it("checks=true 且没有记录 ⇒ 明确说没有检查记录", () => {
    const { container } = renderList({ records: [change()], checks: [] });
    const empty = container.querySelector(".inspector-checks-empty");
    expect(empty?.textContent).toContain("没有检查记录");
  });

  it("checks=true 且有记录 ⇒ 显示命令与结论", () => {
    const { container } = renderList({
      records: [change()],
      checks: [
        { command: "npx tsc --noEmit", ok: true },
        { command: "npx vitest run", ok: false },
      ],
    });
    expect(container.querySelectorAll(".inspector-check")).toHaveLength(2);
    expect(container.textContent).toContain("npx tsc --noEmit");
    expect(container.textContent).toContain("通过");
    expect(container.textContent).toContain("失败");
  });
});

describe("CHG-UI-6 损坏的改动清单必须明说", () => {
  it("filesParseError ⇒ 显示损坏提示，不画成空列表", () => {
    const record = change({ files: [], filesParseError: true, totals: undefined });
    const { container } = renderList({ records: [record] });
    expect(container.querySelector(".inspector-files-error")?.textContent).toContain("损坏");
    expect(screen.queryByText("这一条记录没有可展示的文件")).toBeNull();
  });
});

describe("CHG-UI-7 缺 tree 的记录行不可点", () => {
  it("treesAvailable=false ⇒ 行是静态的（aria-disabled），不会打开 diff", () => {
    const onOpenFile = vi.fn();
    const { container } = renderList({ records: [change({ treesAvailable: false })], onOpenFile });
    const row = container.querySelector(".inspector-file-row")!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

/** 假传输：只实现变更列表/单文件 diff 两条（手机首版的最小面） */
function fakeTransport(over: Record<string, unknown> = {}) {
  return {
    hello: async () => ({ hostId: "h" }),
    listSessions: async () => [],
    getSession: async () => ({ title: "", messages: [] }),
    send: async () => ({ runId: "r" }),
    cancel: async () => undefined,
    subscribe: () => () => undefined,
    ...over,
  } as never;
}

describe("CHG-UI-8 手机分页只追加，不重置", () => {
  it("第一页 1 条 + hasMore；加载更多后两条都在", async () => {
    const sessionChanges = vi
      .fn()
      .mockResolvedValueOnce({ items: [change({ changeId: "a" })], hasMore: true, supported: true })
      .mockResolvedValueOnce({
        items: [
          change({
            changeId: "b",
            createdAt: 2_000_000_000_000,
            files: [{ path: "b.ts", status: "A" }],
          }),
        ],
        hasMore: false,
        supported: true,
      });
    const { container } = render(
      <SessionChangesPane transport={fakeTransport({ sessionChanges })} sessionId="s1" />,
    );

    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("加载更多"));
    await waitFor(() => expect(screen.getByText("b.ts")).toBeTruthy());
    expect(container.querySelectorAll(".turn-change-group"), "第一页的记录要留在历史里（没被重置）").toHaveLength(1);
    fireEvent.click(container.querySelector(".turn-change-header")!);
    // 历史轮次用紧凑行（只显示文件名），展开后第一页的记录仍在
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    expect(sessionChanges).toHaveBeenCalledTimes(2);
    expect(sessionChanges.mock.calls[1]).toEqual(["s1", 1, 20]);
  });

  it("连接没有 sessionChanges ⇒ 明确说不支持（不是空列表）", () => {
    render(<SessionChangesPane transport={fakeTransport()} sessionId="s1" />);
    expect(screen.getByText("此 Host 不记录文件变更")).toBeTruthy();
    expect(screen.getByText(/当前连接不支持变更列表/)).toBeTruthy();
  });
});

describe("CHG-UI-10 手机壳真的接线（不是只写了组件）", () => {
  it("MobileApp 注入 SessionChangesPane，并在运行结束后递增刷新令牌", () => {
    const src = readFileSync("packages/ui/src/mobile-app.tsx", "utf8");
    expect(src).toContain('import { SessionChangesPane } from "./changes-pane"');
    expect(src).toContain("<SessionChangesPane");
    expect(src).toContain("refreshKey={changesRefresh}");
    expect(src).toContain("wasRunning && runState");
  });
});

describe("CHG-UI-9 单文件 diff 走 session.change.diff", () => {
  it("点击文件行 ⇒ 调 RPC，浮层显示 patch 与截断说明", async () => {
    const sessionChanges = vi.fn().mockResolvedValue({ items: [change()], hasMore: false, supported: true });
    const sessionChangeDiff = vi.fn().mockResolvedValue({
      path: "src/a.ts",
      status: "M",
      patch: "+new line",
      truncated: true,
      supported: true,
    });
    render(
      <SessionChangesPane
        transport={fakeTransport({ sessionChanges, sessionChangeDiff })}
        sessionId="s1"
      />,
    );
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/a.ts"));
    // 浮层用共享 patch 视图：正文在行单元格里（不再带 `+` 标记的裸 pre）
    await waitFor(() =>
      expect(document.querySelector(".diff-line--add .diff-line-text")?.textContent).toBe("new line"),
    );
    expect(document.querySelector(".changes-diff-overlay .diff-view-mode-bar")).toBeTruthy();
    expect(sessionChangeDiff).toHaveBeenCalledWith("s1", "tfc-1", "src/a.ts");
    expect(screen.getByText(/diff 已截断/)).toBeTruthy();
  });
});
