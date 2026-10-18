/**
 * DIFFVIEW：Diff 的「统一 / 分屏」两种视图 + 行号 + 行配对。
 *
 * 纯函数判据（`core/ui/diff-view.ts`）+ 一次组件渲染判据（真点按钮切模式）。
 * 背景：对标 open-claude-ui 的 StreamingDiffViewer 有 unified/split 双模式与对齐的
 * 行号 gutter；我们原来只有"把 newText 按行染色"的一列。
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { parseDiffLines, toUnifiedRows, toSplitRows } from "../core/ui/diff-view";
import { DiffBlockCard } from "../components/DiffBlockCard";

describe("DIFFVIEW 行模型", () => {
  const patch = [
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
  ].join("\n");

  it("DIFFVIEW-1: 元数据行（---/+++/@@）不参与配对，正文标记被剥掉", () => {
    const lines = parseDiffLines(patch);
    expect(lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "add"]);
    expect(lines[0].text).toBe("const a = 1;");
  });

  it("DIFFVIEW-2: 统一视图的行号口径（删除只推进旧号、新增只推进新号、上下文两边都推进）", () => {
    const rows = toUnifiedRows(parseDiffLines(patch));
    expect(rows[0]).toMatchObject({ kind: "ctx", oldNum: 1, newNum: 1 });
    expect(rows[1]).toMatchObject({ kind: "del", oldNum: 2, newNum: null });
    expect(rows[2]).toMatchObject({ kind: "add", oldNum: null, newNum: 2 });
    expect(rows[3]).toMatchObject({ kind: "add", oldNum: null, newNum: 3 });
  });

  it("DIFFVIEW-3: 分屏行配对（删/增按顺序配对；多出来的一侧为空）", () => {
    const rows = toSplitRows(parseDiffLines(patch));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "ctx", left: { num: 1 }, right: { num: 1 } });
    expect(rows[1]).toMatchObject({
      kind: "change",
      left: { num: 2, text: "const b = 2;", kind: "del" },
      right: { num: 2, text: "const b = 3;", kind: "add" },
    });
    // 第 3 行只有新增（右侧），左侧必须是 null（不是空字符串占位）
    expect(rows[2].left).toBeNull();
    expect(rows[2].right).toMatchObject({ num: 3, text: "const c = 4;" });
  });

  it("DIFFVIEW-4: 只有新增/只有删除时另一侧整列为空", () => {
    const onlyAdd = toSplitRows(parseDiffLines("+line"));
    expect(onlyAdd).toHaveLength(1);
    expect(onlyAdd[0].left).toBeNull();
    const onlyDel = toSplitRows(parseDiffLines("-line"));
    expect(onlyDel[0].right).toBeNull();
  });

  it("DIFFVIEW-5: 组件默认统一视图，点「分屏」切到网格视图并可切回", () => {
    render(
      <DiffBlockCard
        hunks={[{ path: "app.ts", oldText: null, newText: "-old\n+new\n same" }]}
      />,
    );
    expect(document.querySelector(".diff-unified")).toBeTruthy();
    expect(document.querySelector(".diff-split-grid")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /分屏|Split/ }));
    expect(document.querySelector(".diff-split-grid")).toBeTruthy();
    expect(document.querySelector(".diff-unified")).toBeNull();
    expect(screen.getByRole("button", { name: /分屏|Split/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /统一|Unified/ }));
    expect(document.querySelector(".diff-unified")).toBeTruthy();
  });
});
