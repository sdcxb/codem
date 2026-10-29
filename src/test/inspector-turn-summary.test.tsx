/**
 * Inspector「最近一轮 + 历史轮次」（第 233 轮 · 二次升级 Phase C）。
 *
 * ## 为什么有这一组判据
 *
 * 计划要求：顶部 `最近一轮 +N −N · K 个文件`、文件平铺 43px 行（路径 + M/A + 每文件 +/−）、
 * 「检查」区块在**有数据时显示，无数据时明确说没有**。
 *
 * 数据前置是这一轮才补的：`turn_file_changes.changed_files` 原来只有 path/status，
 * 没有每文件 +/−（现在跟踪器收尾时多跑一条 `git diff --numstat` 写进同一份 JSON）。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | INV-1 | 顶部汇总：`最近一轮` + `第 N 轮` + `+加法 −减法` + `K 个文件`，加减法来自逐文件统计 |
 * | INV-2 | 每文件一行，`+N`/`−M` 与状态徽标（M/A）都在；**缺统计时显示 `+—`，不许显示 +0** |
 * | INV-3 | 没有检查记录 ⇒ 明确写「本轮没有检查记录」；有记录 ⇒ 显示命令与通过/失败 |
 * | INV-4 | 历史轮次仍在（`历史轮次` 标题 + 轮次手风琴），没有被"最近一轮"挤掉 |
 *
 * 变异自证：把合计改成 `files.length` ⇒ INV-1 红；把 `+—` 落回 `+0` ⇒ INV-2 红。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { __resetVerificationChecksForTests, recordVerificationCheck } from "../core/environment/verification-checks";
import { FileChangesList } from "../components/FileChangesList";

vi.mock("../components/DiffViewer", () => ({
  DiffViewer: () => null,
}));

const SESSION = "sess-inv-1";

/** 一轮"最近"记录：两个文件，一个带 numstat、一个缺统计（二进制/旧记录） */
const LATEST_ROW = {
  id: "tfc-2",
  session_id: SESSION,
  message_id: "m-2",
  turn_index: 7,
  before_tree: "b2",
  after_tree: "a2",
  patch: "",
  changed_files: JSON.stringify([
    { path: "src/app/main.ts", status: "M", additions: 12, deletions: 3 },
    { path: "assets/logo.bin", status: "A" },
  ]),
  patch_sha256: null,
  current_brief: "Turn 7: 2 file(s) changed (1 added, 1 modified, 0 deleted)",
  status: "completed",
  created_at: Date.now(),
};

const OLD_ROW = {
  ...LATEST_ROW,
  id: "tfc-1",
  turn_index: 6,
  changed_files: JSON.stringify([{ path: "src/old.ts", status: "M", additions: 1, deletions: 1 }]),
  created_at: Date.now() - 60_000,
};

function mount() {
  const port = createFakeStoragePort({ seed: { turn_file_changes: [LATEST_ROW, OLD_ROW] } });
  setStoragePort(port);
  return port;
}

afterEach(() => {
  cleanup();
  __resetVerificationChecksForTests();
});

describe("Inspector：最近一轮 + 历史轮次", () => {
  it("INV-1: 顶部汇总按逐文件统计求和", async () => {
    mount();
    const { container } = render(<FileChangesList sessionId={SESSION} workspace="C:/ws" />);

    await waitFor(() => {
      const head = container.querySelector(".inspector-latest-head");
      expect(head, "缺少「最近一轮」汇总区").toBeTruthy();
      const text = head!.textContent ?? "";
      expect(text, "要写明是最近一轮").toContain("最近一轮");
      expect(text, "要标出轮次").toContain("第 7 轮");
      expect(text, `加法应为 +12（实际文本：${text}）`).toContain("+12");
      expect(text, `减法应为 −3（实际文本：${text}）`).toContain("−3");
      expect(text, "要写文件数").toContain("2 个文件");
    });
  });

  it("INV-2: 每文件一行；缺统计显示 +— 而不是 +0", async () => {
    mount();
    const { container } = render(<FileChangesList sessionId={SESSION} workspace="C:/ws" />);

    await waitFor(() => {
      expect(container.querySelectorAll(".inspector-file-row"), "最近一轮的两个文件都要平铺出来").toHaveLength(2);
    });
    const rows = [...container.querySelectorAll(".inspector-file-row")];

    const withStats = rows.find((r) => (r.textContent ?? "").includes("src/app/main.ts"))!;
    expect(withStats.textContent, "带统计的文件要显示 +12").toContain("+12");
    expect(withStats.textContent, "带统计的文件要显示 −3").toContain("−3");

    const noStats = rows.find((r) => (r.textContent ?? "").includes("assets/logo.bin"))!;
    expect(noStats.textContent, "缺统计必须显示 +—（不许把「不知道」画成 +0）").toContain("+—");
    expect(noStats.textContent, "缺统计必须显示 −—").toContain("−—");
    expect(noStats.textContent, "缺统计不许出现 +0").not.toContain("+0");
  });

  it("INV-3: 没有检查记录时明确说明；有记录时显示命令与结论", async () => {
    mount();
    __resetVerificationChecksForTests();

    const first = render(<FileChangesList sessionId={SESSION} workspace="C:/ws" />);
    await waitFor(() => {
      const empty = first.container.querySelector(".inspector-checks-empty");
      expect(empty, "没有记录时必须有明确的空态").toBeTruthy();
      expect(empty!.textContent, "空态要写清「没有检查记录」").toContain("没有检查记录");
    });
    first.unmount();

    recordVerificationCheck(SESSION, { command: "npx tsc --noEmit", ok: true });
    recordVerificationCheck(SESSION, { command: "npx vitest run", ok: false });

    const second = render(<FileChangesList sessionId={SESSION} workspace="C:/ws" />);
    await waitFor(() => {
      const items = second.container.querySelectorAll(".inspector-check");
      expect(items.length, "记了两条就该显示两条").toBe(2);
      const text = second.container.querySelector(".inspector-check-list")!.textContent ?? "";
      expect(text, "要显示命令").toContain("npx tsc --noEmit");
      expect(text, "要显示通过").toContain("通过");
      expect(text, "要显示失败").toContain("失败");
    });
  });

  it("INV-4: 历史轮次仍在（没有被最近一轮挤掉）", async () => {
    mount();
    const { container } = render(<FileChangesList sessionId={SESSION} workspace="C:/ws" />);
    await waitFor(() => {
      expect(container.querySelector(".inspector-history-title"), "缺「历史轮次」标题").toBeTruthy();
      expect(container.querySelector(".turn-change-group"), "历史轮次的手风琴必须还在").toBeTruthy();
    });
  });
});
