/**
 * DIFFVIEW：Patch 的「统一 / 分屏」两种视图 + 行号 + 行配对。
 *
 * 纯函数判据（`packages/ui/src/patch-diff.ts`，桌面与手机同一份）
 * + 组件渲染判据（桌面适配器 `DiffBlockCard` 真点按钮切模式）。
 *
 * 背景：对标 open-claude-ui 的 StreamingDiffViewer 有 unified/split 双模式与对齐的
 * 行号 gutter。第 251 波把这些从桌面搬到共享包，并补上真实 patch 的两个解析缺口：
 * hunk 内的 `---`/`+++` 是正文；行号来自 `@@` 头（不是从 1 数）。
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  parsePatchLines,
  toUnifiedRows,
  toSplitRows,
} from "../../packages/ui/src/patch-diff";
import { DIFF_RENDER_ROW_CAP } from "../../packages/ui/src/lcs-diff";
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
    const lines = parsePatchLines(patch);
    expect(lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "add"]);
    expect(lines[0].text).toBe("const a = 1;");
  });

  it("DIFFVIEW-2: 统一视图的行号口径（删除只推进旧号、新增只推进新号、上下文两边都推进）", () => {
    const rows = toUnifiedRows(parsePatchLines(patch));
    expect(rows[0]).toMatchObject({ kind: "ctx", oldNum: 1, newNum: 1 });
    expect(rows[1]).toMatchObject({ kind: "del", oldNum: 2, newNum: null });
    expect(rows[2]).toMatchObject({ kind: "add", oldNum: null, newNum: 2 });
    expect(rows[3]).toMatchObject({ kind: "add", oldNum: null, newNum: 3 });
  });

  it("DIFFVIEW-3: 分屏行配对（删/增按顺序配对；多出来的一侧为空）", () => {
    const rows = toSplitRows(parsePatchLines(patch));
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
    const onlyAdd = toSplitRows(parsePatchLines("+line"));
    expect(onlyAdd).toHaveLength(1);
    expect(onlyAdd[0].left).toBeNull();
    const onlyDel = toSplitRows(parsePatchLines("-line"));
    expect(onlyDel[0].right).toBeNull();
  });

  it("DIFFVIEW-6: hunk 内以 ---/+++ 开头的正文保留（删一行 -- foo / 加一行 ++ bar）", () => {
    const lines = parsePatchLines(
      ["@@ -1,3 +1,3 @@", " keep", "--- foo", "+++ bar", " tail"].join("\n"),
    );
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "ctx:keep",
      "del:-- foo",
      "add:++ bar",
      "ctx:tail",
    ]);
    // 行号也按 hunk 头走：旧 1/2/3，新 1/2/3
    expect(toUnifiedRows(lines).map((r) => [r.oldNum, r.newNum])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
    ]);
  });

  it("DIFFVIEW-7: 行号来自 @@ 头（起点不是 1），多 hunk 之间正确跳号", () => {
    const rows = toUnifiedRows(
      parsePatchLines(
        [
          "@@ -10,2 +20,3 @@",
          " same",
          "-old",
          "+new",
          "+extra",
          "@@ -100,1 +200,1 @@",
          "-a",
          "+b",
        ].join("\n"),
      ),
    );
    expect(rows.map((r) => `${r.kind}:${r.text}:${r.oldNum}:${r.newNum}`)).toEqual([
      "ctx:same:10:20",
      "del:old:11:null",
      "add:new:null:21",
      "add:extra:null:22",
      "del:a:100:null",
      "add:b:null:200",
    ]);
  });

  it("DIFFVIEW-8: 无换行标记不产生行、CRLF 按 LF 处理、二进制块不产生正文行", () => {
    const crlf = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,1 +1,2 @@",
      " same",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\r\n");
    expect(toUnifiedRows(parsePatchLines(crlf)).map((r) => `${r.kind}:${r.text}:${r.oldNum}:${r.newNum}`)).toEqual([
      "ctx:same:1:1",
      "add:new:null:2",
    ]);

    const binary = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    expect(parsePatchLines(binary)).toHaveLength(0);
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

  it("DIFFVIEW-9: 超大 patch 只渲染上限行数，并明确说明被截断（统一/分屏同口径）", () => {
    const total = DIFF_RENDER_ROW_CAP + 100;
    const big = ["@@ -1," + total + " +1," + total + " @@", ...Array.from({ length: total }, (_, i) => ` line ${i + 1}`)].join(
      "\n",
    );
    render(<DiffBlockCard hunks={[{ path: "big.ts", oldText: null, newText: big }]} />);

    expect(document.querySelectorAll(".diff-unified .diff-line")).toHaveLength(DIFF_RENDER_ROW_CAP);
    expect(
      screen.getByText(`内容过长：仅显示前 ${DIFF_RENDER_ROW_CAP} 行（共 ${total} 行 diff 行）`),
      "被截断必须说出来，不能静默少显示",
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /分屏|Split/ }));
    expect(document.querySelectorAll(".diff-split-row")).toHaveLength(DIFF_RENDER_ROW_CAP);
    expect(screen.getByText(new RegExp(`共 ${total} 行 diff 行`))).toBeTruthy();
  });
});
