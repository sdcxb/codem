/**
 * 文件/差异组件共享的接线判据（Phase 5 · 第 1 步）。
 *
 * 主张只有三句：
 * 1. 差异视图的骨架与算法只有**一份**（`packages/ui/src/{diff-view,lcs-diff}.tsx`），
 *    桌面 `src/components/DiffViewer.tsx` 只做平台注入（文案）；
 * 2. 文件树的纯数据层与行组件只有**一份**（`packages/ui/src/{file-tree,file-tree-view}.tsx`），
 *    桌面 `FileExplorer` 只保留 Tauri/缓存/事件/展开，手机 `FileBrowser` 用同一个行组件；
 * 3. 共享包不反向依赖桌面（store / core / src / Tauri）。
 *
 * | # | 行为 |
 * |---|---|
 * | FD-WIRE-1 | 桌面差异入口只剩注入：没有骨架类名、没有算法 |
 * | FD-WIRE-2 | 共享差异/文件树源码不 import 桌面（`../core` / `../../src` / `@tauri-apps`） |
 * | FD-WIRE-3 | 桌面 re-export 的就是共享实现本身（`toBe` 同一函数 + re-export 写法，防第二份） |
 * | FD-WIRE-4 | 桌面入口与共享组件渲染出**同一棵 DOM**（逐字 outerHTML） |
 * | FD-WIRE-5 | 共享差异视图没有硬编码界面文案（全走 `strings`） |
 * | FD-WIRE-6 | 桌面 patch 卡片只剩注入（行 DOM / 解析 / 配对都不在桌面） |
 * | FD-WIRE-7 | 多 hunk 卡片仍只有一个模式条、每个 hunk 一行 |
 * | FD-WIRE-8 | 共享 patch 视图/模型没有硬编码界面文案（全走 `strings`） |
 * | FD-WIRE-9 | 手机三处 patch 面（文件预览 / 差异页签 / 变更浮层）都用共享视图 |
 * | FD-WIRE-10 | 桌面 patch 卡片与共享 body 渲染出同一棵行视图 DOM |
 * | FT-WIRE-1 | 桌面文件树适配器只剩 Tauri/缓存/事件，行 DOM 不在桌面 |
 * | FT-WIRE-2 | 条目模型/图标表/排序/徽章只有一份（桌面没有第二份定义） |
 * | FT-WIRE-3 | 桌面文件树与共享 `FileTree` 渲染出同一棵 DOM |
 * | FT-WIRE-4 | 手机文件浏览用同一个行组件（`.file-entry[role=treeitem]`，旧 `.file-browser-row` 已删） |
 *
 * 变异自证（已实测会红）：在共享差异视图里写死一句「原始内容」⇒ FD-WIRE-5 红；
 * 桌面再定义一份 `DIFF_RENDER_ROW_CAP = 400` ⇒ FD-WIRE-3 红（数字用 `toBe` 抓不到，
 * 所以那条同时钉了 re-export 写法）；把行图标标记抄回 `FileExplorer` ⇒ FT-WIRE-1 红。
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DESKTOP_DIFF_STRINGS,
  DIFF_RENDER_ROW_CAP,
  DiffViewer,
  computeDiff,
} from "../components/DiffViewer";
import { DiffBlockCard } from "../components/DiffBlockCard";
import { DESKTOP_FILE_TREE_STRINGS, FileExplorer } from "../components/FileExplorer";
import { DiffView } from "../../packages/ui/src/diff-view";
import { PatchDiffBody } from "../../packages/ui/src/patch-diff-view";
import { MOBILE_PATCH_DIFF_STRINGS } from "../../packages/ui/src/mobile-patch-diff-strings";
import {
  DIFF_RENDER_ROW_CAP as SHARED_ROW_CAP,
  computeDiff as sharedComputeDiff,
} from "../../packages/ui/src/lcs-diff";
import { FileTree } from "../../packages/ui/src/file-tree-view";
import { GIT_STATUS_BADGES, getFileIcon, sortEntries, type FileTreeEntry } from "../../packages/ui/src/file-tree";
import { FileBrowser } from "../../packages/ui/src/file-browser";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI__;
});

/** 去掉注释再判"源码里有没有某个字面量"，避免注释把判据哄绿 */
function readWithoutComments(rel: string): string {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const DIFF_PROPS = {
  filePath: "src/a.ts",
  before: "a\nb\nc",
  after: "a\nB\nc\nd",
  onAccept: () => undefined,
  onReject: () => undefined,
  onCustom: () => undefined,
  onClose: () => undefined,
};

describe("FD-WIRE：差异视图只有一份实现", () => {
  it("FD-WIRE-1: 桌面入口只剩注入，没有骨架/算法/文案", () => {
    const entry = readWithoutComments("src/components/DiffViewer.tsx");
    expect(entry, "必须渲染共享差异视图").toContain("DiffView");
    expect(entry, "必须注入桌面文案").toContain("DESKTOP_DIFF_STRINGS");
    // 骨架不在桌面：类名与模式按钮都不该出现
    expect(entry, "入口不许再有差异骨架").not.toContain("diff-view-mode-toggle");
    expect(entry).not.toContain("diff-preview-content");
    expect(entry).not.toContain("diff-truncated-note");
    // 算法不在桌面
    expect(entry, "入口不许再自带 diff 算法").not.toContain("dp[i][j]");
    expect(entry).not.toContain("unshift");
  });

  it("FD-WIRE-5: 共享差异视图没有硬编码界面文案（全走 strings）", () => {
    const shared = readWithoutComments("packages/ui/src/diff-view.tsx");
    for (const literal of ["原始内容", "写入内容", "新文件", "仅显示前", "提交指令", "取消", "关闭", ">Original<", ">Modified<"]) {
      expect(shared, `共享差异视图里不许写死「${literal}」（应由宿主注入）`).not.toContain(literal);
    }
    // 反证：桌面注入对象确实带这些文案（否则上面的断言等于没测）
    expect(DESKTOP_DIFF_STRINGS.originalLabel).toBe("原始内容");
    expect(DESKTOP_DIFF_STRINGS.splitOriginal).toBe("Original");
  });

  it("FD-WIRE-2: 共享差异/文件树源码不反向依赖桌面", () => {
    for (const file of [
      "packages/ui/src/diff-view.tsx",
      "packages/ui/src/lcs-diff.ts",
      "packages/ui/src/patch-diff.ts",
      "packages/ui/src/patch-diff-view.tsx",
      "packages/ui/src/file-tree-view.tsx",
      "packages/ui/src/file-tree.ts",
    ]) {
      const src = readWithoutComments(file);
      expect(src, `${file} 不得 import 桌面 store`).not.toContain('from "../store"');
      expect(src, `${file} 不得 import 桌面 core`).not.toContain('from "../core');
      expect(src, `${file} 不得 import 桌面 src`).not.toContain('from "../../src');
      expect(src, `${file} 不得直接使用 Tauri`).not.toContain("@tauri-apps");
      expect(src, `${file} 不得读 window.__TAURI__`).not.toContain("__TAURI__");
    }
  });

  it("FD-WIRE-3: 桌面 re-export 的就是共享实现（没有第二份算法/常量）", () => {
    expect(computeDiff, "桌面 computeDiff 必须是共享函数本体").toBe(sharedComputeDiff);
    expect(DIFF_RENDER_ROW_CAP, "渲染上限必须是同一个常量").toBe(SHARED_ROW_CAP);
    const entry = readWithoutComments("src/components/DiffViewer.tsx");
    expect(entry, "桌面不许再定义一份算法").not.toContain("function computeDiff");
    /* 数字是原始值，`toBe` 抓不到"桌面另定义一份 400"⇒ 这里钉 re-export 的写法本身：
       必须是 `export { … DIFF_RENDER_ROW_CAP } from "<共享模块>"`，不许出现本地赋值。 */
    expect(entry, "渲染上限必须 re-export（不许本地再定义一份）").not.toMatch(
      /(const|let|var)\s+DIFF_RENDER_ROW_CAP\s*=/,
    );
    expect(entry).toMatch(/export\s*\{[^}]*DIFF_RENDER_ROW_CAP[^}]*\}\s*from\s*"\.\.\/\.\.\/packages\/ui\/src\/lcs-diff"/);
  });

  it("FD-WIRE-4: 桌面入口与共享组件渲染出同一棵 DOM", () => {
    render(<DiffViewer {...DIFF_PROPS} />);
    const desktopHtml = document.querySelector(".diff-viewer")!.outerHTML;
    cleanup();

    render(<DiffView {...DIFF_PROPS} strings={DESKTOP_DIFF_STRINGS} />);
    const sharedHtml = document.querySelector(".diff-viewer")!.outerHTML;
    expect(desktopHtml, "桌面差异视图必须与共享组件逐字一致（只允许注入文案）").toBe(sharedHtml);
  });
});

describe("PATCH-WIRE：patch 渲染器只有一份（桌面卡片 + 手机三处）", () => {
  const PATCH = "-old\n+new\n same";

  it("FD-WIRE-6: 桌面 DiffBlockCard 只剩注入（行 DOM / 解析 / 配对都不在桌面）", () => {
    const entry = readWithoutComments("src/components/DiffBlockCard.tsx");
    expect(entry, "桌面卡片必须渲染共享 body").toContain("<PatchDiffBody");
    expect(entry, "桌面卡片必须渲染共享模式条").toContain("<PatchDiffModeBar");
    expect(entry, "文案必须由桌面注入（getLang）").toContain("getLang");
    for (const marker of [
      "diff-line--",
      "diff-split-row",
      "diff-unified",
      "parsePatchLines",
      "toUnifiedRows",
      "toSplitRows",
    ]) {
      expect(entry, `桌面卡片不许自带行 DOM/解析：${marker}`).not.toContain(marker);
    }
  });

  it("FD-WIRE-7: 多 hunk 卡片仍只有一个模式条，每个 hunk 一行", () => {
    render(
      <DiffBlockCard
        hunks={[
          { path: "a.ts", oldText: null, newText: PATCH },
          { path: "b.ts", oldText: null, newText: "@@ -5,1 +5,1 @@\n-c\n+d" },
        ]}
      />,
    );
    expect(document.querySelectorAll(".diff-view-mode-bar")).toHaveLength(1);
    expect(document.querySelectorAll(".diff-block > .tool-card-row")).toHaveLength(2);
    expect(document.querySelectorAll("pre.diff-unified")).toHaveLength(2);
  });

  it("FD-WIRE-8: 共享 patch 视图/模型没有硬编码界面文案（全走 strings）", () => {
    const view = readWithoutComments("packages/ui/src/patch-diff-view.tsx");
    const model = readWithoutComments("packages/ui/src/patch-diff.ts");
    for (const literal of ["统一", "分屏", "仅显示前", "没有未提交", "不是 git", "内容过长"]) {
      expect(view, `共享视图里不许写死「${literal}」`).not.toContain(literal);
      expect(model, `共享模型里不许写死「${literal}」`).not.toContain(literal);
    }
    // 反证：手机壳注入对象确实带这些文案（否则上面的断言等于没测）
    expect(MOBILE_PATCH_DIFF_STRINGS.unified).toBe("统一");
    expect(MOBILE_PATCH_DIFF_STRINGS.truncated(1, 2)).toContain("仅显示前");
  });

  it("FD-WIRE-9: 手机三处 patch 面都用共享视图（文件预览两处 + 变更浮层）", () => {
    const browser = readWithoutComments("packages/ui/src/file-browser.tsx");
    expect(browser.match(/<PatchDiffView/g) ?? [], "文件预览与差异页签各一处").toHaveLength(2);
    expect(browser, "不再直接输出裸 patch <pre>").not.toContain('<pre className="file-browser-preview"');
    const changes = readWithoutComments("packages/ui/src/changes-list.tsx");
    expect(changes, "变更浮层也用共享视图").toContain("<PatchDiffView");
    expect(changes, "旧的裸 pre 已删除").not.toContain("changes-diff-pre");
  });

  it("FD-WIRE-10: 桌面卡片与共享 body 渲染出同一棵行视图 DOM", () => {
    render(<DiffBlockCard hunks={[{ path: "a.ts", oldText: null, newText: PATCH }]} />);
    const desktopHtml = document.querySelector(".diff-block pre.diff-unified")!.outerHTML;
    cleanup();

    render(<PatchDiffBody patch={PATCH} mode="unified" strings={MOBILE_PATCH_DIFF_STRINGS} />);
    const sharedHtml = document.querySelector("pre.diff-unified")!.outerHTML;
    expect(desktopHtml, "桌面卡片必须只做注入（行视图逐字一致）").toBe(sharedHtml);
  });
});

/** 桌面文件树的 Tauri 桩：`list_directory` 返回两层树，`execute_command`（git status）给一条 M */
function installTauriStub(): void {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_directory") {
      const path = String(args?.path ?? "");
      if (path === "C:/ws") {
        return [
          { name: "src", path: "C:/ws/src", isDirectory: true },
          { name: "README.md", path: "C:/ws/README.md", isDirectory: false },
        ];
      }
      if (path === "C:/ws/src") {
        return [{ name: "a.ts", path: "C:/ws/src/a.ts", isDirectory: false }];
      }
      return [];
    }
    if (command === "execute_command") {
      /*
       * 2026-11-10：这条判据只比较文件树 DOM，不测 git 状态。
       * 原 stub 返回 git status，会让桌面树在异步刷新后多一个 badge，
       * 而共享 FileTree 的 entries 没有 gitStatus ⇒ outerHTML 偶发不等（全量并行时红）。
       * 固定为空，去掉与判据无关的异步维度。
       */
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return null;
  });
  (window as any).__TAURI__ = { core: { invoke } };
}

describe("FT-WIRE：文件树只有一份实现", () => {
  it("FT-WIRE-1: 桌面适配器只剩平台能力，行 DOM 不在桌面", () => {
    const entry = readWithoutComments("src/components/FileExplorer.tsx");
    expect(entry, "必须渲染共享文件树").toContain("FileTree");
    expect(entry, "必须注入桌面文案").toContain("DESKTOP_FILE_TREE_STRINGS");
    // 平台能力保留在桌面
    for (const marker of [
      'invoke("list_directory", { path, showHidden: true })',
      "dirCache",
      "onFileChangesTracked",
      "refreshKey",
    ]) {
      expect(entry, `桌面适配器必须仍负责：${marker}`).toContain(marker);
    }
    // 行结构不再重复
    expect(entry, "桌面不许再自带行 DOM").not.toContain("file-entry-icon");
    expect(entry).not.toContain('role="treeitem"');
    expect(entry).not.toContain("git-status-badge");
  });

  it("FT-WIRE-2: 条目模型/图标/排序/徽章只有一份定义", () => {
    const entry = readWithoutComments("src/components/FileExplorer.tsx");
    expect(entry, "桌面不许再定义第二份条目类型").not.toContain("interface FileEntry");
    expect(entry, "桌面不许再定义第二份图标表").not.toContain("EXT_ICON_MAP");
    expect(entry, "桌面不许再定义第二份徽章表").not.toContain("GIT_STATUS_BADGES");
    expect(entry, "桌面不许再定义第二份排序").not.toContain("function sortEntries");
    expect(read("packages/ui/src/file-tree.ts"), "徽章表必须在共享包").toContain("GIT_STATUS_BADGES");
    expect(typeof sortEntries).toBe("function");
    expect(getFileIcon("a.ts")).toBeTruthy();
    expect(GIT_STATUS_BADGES.M.className).toBe("git-status-modified");
  });

  it("FT-WIRE-3: 桌面文件树与共享 FileTree 渲染出同一棵 DOM", async () => {
    installTauriStub();
    const first = render(<FileExplorer cwd="C:/ws" />);
    await waitFor(() => {
      expect(first.container.querySelectorAll(".file-tree .file-entry").length).toBe(2);
      // git status 二次刷新会短暂置 loading：必须等它结束再快照，否则采到 "正在加载..." 窗口（FT-WIRE-3 偶发红）
      expect(first.container.querySelector(".empty-hint")).toBeNull();
    });
    const desktopHtml = first.container.querySelector(".file-explorer")!.outerHTML;
    cleanup();

    const entries: FileTreeEntry[] = sortEntries([
      { name: "src", path: "C:/ws/src", isDirectory: true, gitStatus: undefined, children: undefined },
      { name: "README.md", path: "C:/ws/README.md", isDirectory: false, gitStatus: undefined, children: undefined },
    ]);
    render(
      <FileTree
        entries={entries}
        strings={DESKTOP_FILE_TREE_STRINGS}
        expanded={new Set<string>()}
        query=""
        onQueryChange={() => undefined}
        onRefresh={() => undefined}
        onToggle={() => undefined}
        onOpenFile={() => undefined}
        loading={false}
      />,
    );
    const sharedHtml = document.querySelector(".file-explorer")!.outerHTML;
    expect(desktopHtml, "桌面文件树必须与共享组件逐字一致（只允许注入数据/回调）").toBe(sharedHtml);
  });

  it("FT-WIRE-4: 手机文件浏览用同一个行组件（无第二套列表）", async () => {
    const transport = {
      listWorkspace: vi.fn(async (path: string) => {
        if (path === "" || path === ".") {
          return {
            path: "",
            entries: [
              { name: "src", type: "dir" as const },
              { name: "README.md", type: "file" as const, size: 12 },
            ],
          };
        }
        if (path === "src") return { path: "src", entries: [{ name: "a.ts", type: "file" as const, size: 5 }] };
        return { path, entries: [] };
      }),
      readWorkspace: vi.fn(async (path: string) => ({ path, size: 5, truncated: false, text: `content of ${path}` })),
    };
    const { container } = render(<FileBrowser transport={transport as never} onClose={() => undefined} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".file-browser .file-entry").length).toBe(2);
    });
    const rows = [...container.querySelectorAll(".file-browser .file-entry")];
    expect(rows.map((r) => r.getAttribute("role"))).toEqual(["treeitem", "treeitem"]);
    expect(rows[1].textContent, "尺寸仍要显示（手机功能保留）").toContain("12 B");
    // 旧的手机专用行已经删除：D 力保"只有一份行组件"
    expect(container.querySelector(".file-browser-row"), "旧行组件必须已删").toBeNull();
    expect(readWithoutComments("packages/ui/src/file-browser.tsx"), "手机必须复用共享文件树").toContain(
      'from "./file-tree-view"',
    );
  });
});
