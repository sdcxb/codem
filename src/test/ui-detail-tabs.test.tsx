/**
 * 宽屏第三列判据（DT-1..DT-6）：文件 / 差异。
 *
 * 这些用例走的是**真实组件**（`WorkspaceDetail` + `FileBrowser` + `WorkspaceDiffPane`），
 * 不是照着 MobileApp 的 JSX 另写一份骨架：`MobileApp` 一挂载就要连 Host，
 * 所以只能把"页签状态机 + 面板常驻 + 选择联动"抽到可渲染的组件上再测。
 *
 * 关键不变量：
 * - 未选文件时切到「差异」**不发请求**（先请求再说的实现会在这里红）；
 * - 「不是 git 仓库」「出错」「没有改动」是三种不同文案，不许互相冒充；
 * - 切页签用 `hidden` 而不是卸载（FileBrowser 的目录层级要留着）。
 */
import { useState, type ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceDetail, type DetailTab } from "../../packages/ui/src/detail-pane";
import { FileBrowser, WorkspaceDiffPane } from "../../packages/ui/src/file-browser";

function transport(overrides: Record<string, unknown> = {}) {
  return {
    listWorkspace: vi.fn(async (path: string) => {
      if (path === "" || path === ".") {
        return { path: "", entries: [{ name: "src", type: "dir" }, { name: "README.md", type: "file", size: 12 }] };
      }
      if (path === "src") return { path: "src", entries: [{ name: "a.ts", type: "file", size: 5 }] };
      return { path, entries: [] };
    }),
    readWorkspace: vi.fn(async (path: string) => ({ path, size: 5, truncated: false, text: `content of ${path}` })),
    diffWorkspace: vi.fn(async (path: string) => ({
      path,
      supported: true,
      diff: `--- a/${path}\n+++ b/${path}\n-# old\n+# new`,
    })),
    ...overrides,
  } as never;
}

/** MobileApp 的接线镜像：选中文件**不自动跳页签**，差异页签始终看"当前选中文件" */
function Harness(props: { transport: never }): ReactElement {
  const [tab, setTab] = useState<DetailTab>("files");
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <WorkspaceDetail
      tab={tab}
      onSelectTab={setTab}
      files={
        <FileBrowser
          transport={props.transport}
          onClose={() => undefined}
          inline
          onSelectFile={setSelected}
        />
      }
      diff={
        <WorkspaceDiffPane
          transport={props.transport}
          path={selected}
          onChooseFile={() => setTab("files")}
        />
      }
    />
  );
}

const panel = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  expect(el, `找不到面板 #${id}`).toBeTruthy();
  return el!;
};

describe("DT-1 默认页签", () => {
  it("默认停在「文件」：aria-selected、面板显隐都对", () => {
    render(
      <WorkspaceDetail
        tab="files"
        onSelectTab={() => undefined}
        files={<div>files-body</div>}
        diff={<div>diff-body</div>}
      />,
    );
    expect(document.getElementById("detail-tab-files")?.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("detail-tab-diff")?.getAttribute("aria-selected")).toBe("false");
    expect(panel("detail-panel-files").hasAttribute("hidden")).toBe(false);
    expect(panel("detail-panel-diff").hasAttribute("hidden")).toBe(true);
    expect(panel("detail-panel-files").getAttribute("role")).toBe("tabpanel");
    expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("工作区");
  });
});

describe("DT-2 未选文件时切「差异」", () => {
  it("给明确空态，且**一次 diff 请求都不发**", async () => {
    const t = transport();
    render(<Harness transport={t} />);
    await screen.findByText("README.md"); // 初始目录列表落地（避免把异步 setState 留到用例之外）
    fireEvent.click(screen.getByRole("tab", { name: "差异" }));
    expect(screen.getByText(/先在「文件」里选一个文件/)).toBeTruthy();
    expect(t.diffWorkspace).toHaveBeenCalledTimes(0);
    expect(panel("detail-panel-diff").hasAttribute("hidden")).toBe(false);
  });

  it("空态里的「去选择」回到文件页签", async () => {
    render(<Harness transport={transport()} />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("tab", { name: "差异" }));
    fireEvent.click(screen.getByText("去选择"));
    expect(document.getElementById("detail-tab-files")?.getAttribute("aria-selected")).toBe("true");
    expect(panel("detail-panel-files").hasAttribute("hidden")).toBe(false);
  });
});

describe("DT-3 三种结果不许互相冒充", () => {
  it("选中文件后切差异：请求带上相对路径，显示 patch", async () => {
    const t = transport();
    render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    await waitFor(() =>
      expect(document.querySelector(".diff-line--add .diff-line-text")?.textContent).toBe("# new"),
    );
    expect(t.diffWorkspace).toHaveBeenCalledTimes(1);
    expect(t.diffWorkspace).toHaveBeenCalledWith("src/a.ts");
    expect(document.querySelector(".file-browser-path")?.textContent).toBe("src/a.ts");
  });

  it("supported=false（不是 git 仓库）", async () => {
    const t = transport({
      diffWorkspace: vi.fn(async (path: string) => ({ path, diff: "", supported: false })),
    });
    render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    expect(await screen.findByText(/此工作区不是 git 仓库/)).toBeTruthy();
    expect(screen.queryByText(/没有未提交的改动/)).toBeNull();
  });

  it("supported=false 带服务端 reason 时优先显示它（未跟踪二进制 ≠ 不是 git 仓库）", async () => {
    const t = transport({
      diffWorkspace: vi.fn(async (path: string) => ({
        path,
        diff: "",
        supported: false,
        reason: "该文件是二进制（或非 UTF-8）新文件，无法显示文本差异。",
      })),
    });
    render(<WorkspaceDiffPane transport={t} path="new.bin" />);
    expect(await screen.findByText(/二进制（或非 UTF-8）新文件/)).toBeTruthy();
    expect(screen.queryByText(/此工作区不是 git 仓库/)).toBeNull();
  });

  it("抛错：错误原文可见，且不画成「没有改动」", async () => {
    const t = transport({
      diffWorkspace: vi.fn(async () => {
        throw new Error("git 不可用");
      }),
    });
    render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    expect(await screen.findByText(/git 不可用/)).toBeTruthy();
    expect(screen.queryByText(/没有未提交的改动/)).toBeNull();
  });

  it("diff 为空（trim 后）才显示「没有未提交的改动」", async () => {
    const t = transport({ diffWorkspace: vi.fn(async (path: string) => ({ path, diff: " \n ", supported: true })) });
    render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    expect(await screen.findByText(/没有未提交的改动/)).toBeTruthy();
  });
});

describe("DT-4 切页签不丢文件树位置（hidden 而非卸载）", () => {
  it("进 src → 切差异 → 切回：目录仍是 src；选中文件不自动跳页签", async () => {
    const t = transport();
    render(<Harness transport={t} />);
    fireEvent.click(await screen.findByText("src"));
    await waitFor(() => expect(panel("detail-panel-files").querySelector(".file-browser-path")?.textContent).toBe("src"));

    fireEvent.click(screen.getByRole("tab", { name: "差异" }));
    expect(screen.getByText(/先在「文件」里选一个文件/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "文件" }));
    expect(panel("detail-panel-files").querySelector(".file-browser-path")?.textContent).toBe("src");

    // 选中一个文件：页签仍停在「文件」（不打断浏览），随后切「差异」才看 diff
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    expect(document.getElementById("detail-tab-files")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "差异" }));
    await waitFor(() => expect(t.diffWorkspace).toHaveBeenCalledWith("src/a.ts"));
    await waitFor(() =>
      expect(document.querySelector(".diff-line--add .diff-line-text")?.textContent).toBe("# new"),
    );
    expect(document.getElementById("detail-tab-diff")?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("DT-5 连接不支持 diff", () => {
  it("transport 没有 diffWorkspace 时明说，且不渲染刷新按钮", () => {
    const t = transport({ diffWorkspace: undefined });
    render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    expect(screen.getByText(/当前连接不支持 diff/)).toBeTruthy();
    expect(screen.queryByText("刷新")).toBeNull();
  });
});

describe("DT-6 刷新按钮", () => {
  it("手动刷新会再取一次（没有工作区变更事件，不假装实时）", async () => {
    const t = transport();
    render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    await waitFor(() => expect(t.diffWorkspace).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("刷新"));
    await waitFor(() => expect(t.diffWorkspace).toHaveBeenCalledTimes(2));
  });
});

describe("DT-8 差异页签用共享 patch 视图（不是裸 <pre>）", () => {
  it("ready 有模式条并可切分屏；空 / 非 git / 出错都不画行视图", async () => {
    const t = transport();
    const ready = render(<WorkspaceDiffPane transport={t} path="src/a.ts" />);
    await waitFor(() => expect(ready.container.querySelector(".diff-view-mode-bar")).toBeTruthy());
    expect(ready.container.querySelector(".patch-diff")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    expect(ready.container.querySelector(".diff-split-grid")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "统一" }));
    expect(ready.container.querySelector(".diff-unified")).toBeTruthy();
    ready.unmount();

    const notGit = transport({
      diffWorkspace: vi.fn(async (path: string) => ({ path, supported: false, diff: "" })),
    });
    const a = render(<WorkspaceDiffPane transport={notGit} path="src/a.ts" />);
    expect(await screen.findByText(/此工作区不是 git 仓库/)).toBeTruthy();
    expect(a.container.querySelector(".diff-unified")).toBeNull();
    expect(a.container.querySelector(".diff-view-mode-bar")).toBeNull();
    a.unmount();

    const failing = transport({
      diffWorkspace: vi.fn(async () => {
        throw new Error("git 不可用");
      }),
    });
    const b = render(<WorkspaceDiffPane transport={failing} path="src/a.ts" />);
    expect(await screen.findByText(/git 不可用/)).toBeTruthy();
    expect(b.container.querySelector(".diff-unified")).toBeNull();
    b.unmount();

    const empty = transport({
      diffWorkspace: vi.fn(async (path: string) => ({ path, supported: true, diff: " \n " })),
    });
    const c = render(<WorkspaceDiffPane transport={empty} path="src/a.ts" />);
    expect(await screen.findByText(/没有未提交的改动/)).toBeTruthy();
    expect(c.container.querySelector(".diff-unified")).toBeNull();
    expect(c.container.querySelector(".diff-view-mode-bar")).toBeNull();
    c.unmount();
  });
});

describe("DT-7 「变更」页签（第 270 波）", () => {
  function ChangesHarness(): ReactElement {
    const [tab, setTab] = useState<DetailTab>("files");
    return (
      <WorkspaceDetail
        tab={tab}
        onSelectTab={setTab}
        files={<div data-testid="files-body">files-body</div>}
        diff={<div data-testid="diff-body">diff-body</div>}
        changes={<div data-testid="changes-body">changes-body</div>}
      />
    );
  }

  it("注入 changes 才出现页签；切换用 hidden，不卸载其它面板", () => {
    render(<ChangesHarness />);
    expect(document.getElementById("detail-tab-changes")?.textContent).toBe("变更");
    expect(panel("detail-panel-changes").hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "变更" }));
    expect(panel("detail-panel-changes").hasAttribute("hidden")).toBe(false);
    expect(panel("detail-panel-files").hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("files-body"), "文件面板必须仍在 DOM 里（hidden 而非卸载）").toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "文件" }));
    expect(panel("detail-panel-changes").hasAttribute("hidden")).toBe(true);
    expect(panel("detail-panel-files").hasAttribute("hidden")).toBe(false);
  });

  it("没有 changes 注入 ⇒ 不画空页签", () => {
    render(
      <WorkspaceDetail
        tab="files"
        onSelectTab={() => undefined}
        files={<div>f</div>}
        diff={<div>d</div>}
      />,
    );
    expect(document.getElementById("detail-tab-changes")).toBeNull();
    expect(document.getElementById("detail-panel-changes")).toBeNull();
  });
});
