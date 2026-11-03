/**
 * 文件浏览/预览判据（FB-1..9）：
 * - 根目录列出（目录在前）；
 * - 点目录进入下一层，点文件出只读预览；
 * - 传输不支持时明确提示（不渲染假数据）；
 * - 只读 diff 按钮（改为共享 patch 视图：行号/行文本 + 模式条，不再输出裸 patch 文本）；
 * - 超大 patch 有界并说明截断；空 diff / 非 git 不冒充行视图；
 * - **选择联动**：打开文件上报相对路径，返回/换目录上报 null（第三列差异页签靠它绑定）。
 */
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileBrowser } from "../../packages/ui/src/file-browser";
import { HostRpcError } from "../../packages/ui/src/host-client";
import { DIFF_RENDER_ROW_CAP } from "../../packages/ui/src/lcs-diff";

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
    diffWorkspace: vi.fn(async (path: string) => ({ path, supported: true, diff: `--- a/${path}\n+++ b/${path}\n-# old\n+# new` })),
    ...overrides,
  } as never;
}

describe("FB-1 根目录", () => {
  it("列出目录与文件（目录在前）", async () => {
    render(<FileBrowser transport={transport()} onClose={() => undefined} />);
    expect(await screen.findByText("src")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });
});

describe("FB-2 进入目录 + 预览", () => {
  it("点目录进入；点文件显示内容", async () => {
    render(<FileBrowser transport={transport()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("a.ts")).toBeTruthy();
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
  });
});

describe("FB-3 不支持时明说", () => {
  it("没有 listWorkspace/readWorkspace 时显示提示", () => {
    render(<FileBrowser transport={{} as never} onClose={() => undefined} />);
    expect(screen.getByText(/不支持文件浏览/)).toBeTruthy();
  });
});

describe("FB-4 只读 diff", () => {
  it("点 Diff 用共享 patch 视图显示（行号 + 行文本，不再是裸 patch 文本）", async () => {
    const { container } = render(<FileBrowser transport={transport()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));

    await waitFor(() =>
      expect(container.querySelector(".diff-line--add .diff-line-text")?.textContent).toBe("# new"),
    );
    expect(container.querySelector(".diff-line--del .diff-line-text")?.textContent).toBe("# old");
    // 行号来自 patch（片段输入从 1 开始）：删除行旧号 1、新增行新号 1
    expect(container.querySelector(".diff-line--del .diff-lnum--old")?.textContent).toBe("1");
    // 裸 `<pre>` 不再直接吐 patch 文本
    expect(container.querySelector(".file-browser-preview")?.textContent).not.toContain("--- a/src/a.ts");
  });
});

describe("FB-6 共享 patch 视图（模式条 + 分屏）", () => {
  it("点 Diff 后出现模式条，可切「分屏」再切回「统一」", async () => {
    const { container } = render(<FileBrowser transport={transport()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));

    await waitFor(() => expect(container.querySelector(".diff-view-mode-bar")).toBeTruthy());
    expect(container.querySelector(".diff-unified")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    expect(container.querySelector(".diff-split-grid")).toBeTruthy();
    expect(container.querySelector(".diff-unified")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "统一" }));
    expect(container.querySelector(".diff-unified")).toBeTruthy();
  });
});

describe("FB-7 超大 patch 有界", () => {
  it("只渲染上限行数，并明确说明被截断", async () => {
    const total = DIFF_RENDER_ROW_CAP + 50;
    const big = [
      `@@ -1,${total} +1,${total} @@`,
      ...Array.from({ length: total }, (_, i) => ` line ${i + 1}`),
    ].join("\n");
    const t = transport({
      diffWorkspace: vi.fn(async (path: string) => ({ path, supported: true, diff: big })),
    });
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));

    await waitFor(() =>
      expect(container.querySelectorAll(".diff-line")).toHaveLength(DIFF_RENDER_ROW_CAP),
    );
    expect(screen.getByText(new RegExp(`仅显示前 ${DIFF_RENDER_ROW_CAP} 行`))).toBeTruthy();
  });
});

describe("FB-8 空态 / 非 git 不冒充 patch 视图", () => {
  it("diff trim 为空 ⇒ 「没有未提交的改动」，不画行视图", async () => {
    const t = transport({
      diffWorkspace: vi.fn(async (path: string) => ({ path, supported: true, diff: " \n " })),
    });
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));

    await waitFor(() => expect(screen.getByText(/没有未提交的改动/)).toBeTruthy());
    expect(container.querySelector(".diff-unified")).toBeNull();
    expect(container.querySelector(".diff-view-mode-bar")).toBeNull();
  });

  it("不是 git 仓库 ⇒ 说明文案，不画行视图", async () => {
    const t = transport({
      diffWorkspace: vi.fn(async (path: string) => ({ path, supported: false, diff: "" })),
    });
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));

    await waitFor(() => expect(screen.getByText(/不是 git 仓库/)).toBeTruthy());
    expect(container.querySelector(".diff-unified")).toBeNull();
  });
});

describe("FB-10 敏感读取的内联审批（两阶段）", () => {
  function approvalError(tool: "workspace.read" | "workspace.diff", path: string): HostRpcError {
    return new HostRpcError("需要审批", "APPROVAL_REQUIRED", -32008, false, {
      details: {
        approvalRequired: true,
        approvalId: "appr-ui-1",
        tool,
        summary: `读取敏感文件 ${path}（环境变量文件）—— 批准后内容将发送给模型`,
        details: {
          path,
          rule: "env",
          label: "环境变量文件",
          reason: "可能包含 API Key、数据库口令等凭据",
          risk: "high",
          scope: "shared-desktop-workspace",
          notice: "批准后文件内容会发送给模型（及模型服务商）；拒绝则不会读取任何字节。",
        },
        expiresAt: Date.now() + 300_000,
      },
    });
  }

  function sensitiveTransport(overrides: Record<string, unknown> = {}) {
    return transport({
      listWorkspace: vi.fn(async (path: string) =>
        path === "" || path === "."
          ? { path: "", entries: [{ name: ".env", type: "file", size: 10 }] }
          : { path, entries: [] },
      ),
      readWorkspace: vi.fn(async (path: string, _offset?: number, _limit?: number, approvalId?: string) => {
        if (!approvalId) throw approvalError("workspace.read", path);
        return { path, size: 10, truncated: false, text: `content of ${path}` };
      }),
      respondApproval: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it("首次只出卡、不出正文；批准后带 approvalId 重试出正文；没有「始终允许」", async () => {
    const t = sensitiveTransport();
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText(".env"));

    await waitFor(() => expect(container.querySelector(".decision-tray")).toBeTruthy());
    const card = container.querySelector(".decision-tray")!;
    expect(card.textContent).toContain(".env");
    expect(card.textContent).toContain("环境变量文件");
    expect(card.textContent).toContain("发送给模型");
    expect(card.textContent).toContain("高风险");
    expect(card.textContent).toContain("[共享桌面工作区]");
    expect(card.textContent).not.toContain("SECRET");
    expect(container.querySelector(".file-browser-preview")).toBeNull();
    expect(screen.queryByText("始终允许"), "读取审批没有会话记忆，不许提供始终允许").toBeNull();

    fireEvent.click(screen.getByText("批准"));
    await waitFor(() => expect(screen.getByText("content of .env")).toBeTruthy());
    expect(t.respondApproval).toHaveBeenCalledWith("appr-ui-1", "allow", expect.any(String));
    expect(t.readWorkspace).toHaveBeenLastCalledWith(".env", 0, 200_000, "appr-ui-1");
    await waitFor(() => expect(container.querySelector(".decision-tray")).toBeNull());
  });

  it("拒绝：答复 deny、不出正文，并明确写「已拒绝」", async () => {
    const t = sensitiveTransport();
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText(".env"));
    await waitFor(() => expect(container.querySelector(".decision-tray")).toBeTruthy());

    fireEvent.click(screen.getByText("拒绝"));
    await waitFor(() => expect(screen.getByText(/已拒绝读取敏感文件/)).toBeTruthy());
    expect(t.respondApproval).toHaveBeenCalledWith("appr-ui-1", "deny", expect.any(String));
    expect(screen.queryByText("content of .env")).toBeNull();
    expect(container.querySelector(".decision-tray")).toBeNull();
  });

  it("普通文件：零审批（行为不变）", async () => {
    const t = transport();
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    expect(container.querySelector(".decision-tray")).toBeNull();
  });
});

describe("FB-11 敏感 diff 的内联审批", () => {
  function diffApprovalError(path: string): HostRpcError {
    return new HostRpcError("需要审批", "APPROVAL_REQUIRED", -32008, false, {
      details: {
        approvalRequired: true,
        approvalId: "appr-ui-diff",
        tool: "workspace.diff",
        summary: "查看差异时将读取 1 个敏感文件（环境变量文件）—— 批准后内容将发送给模型",
        details: {
          path,
          base: "HEAD",
          files: [".env"],
          fileCount: 1,
          risk: "high",
          scope: "shared-desktop-workspace",
          notice: "批准后这些文件的差异内容会发送给模型（及模型服务商）；拒绝则不会返回任何 patch。",
        },
        expiresAt: Date.now() + 300_000,
      },
    });
  }

  function diffTransport(overrides: Record<string, unknown> = {}) {
    return transport({
      diffWorkspace: vi.fn(async (path: string, _base?: string, approvalId?: string) => {
        if (!approvalId) throw diffApprovalError(path);
        return { path, supported: true, diff: `--- a/${path}\n+++ b/${path}\n-# old\n+# new` };
      }),
      respondApproval: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it("批准后显示 patch；拒绝则不出 patch", async () => {
    const t = diffTransport();
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));

    await waitFor(() => expect(container.querySelector(".decision-tray")).toBeTruthy());
    expect(container.querySelector(".diff-unified")).toBeNull();
    expect(container.querySelector(".decision-tray")!.textContent).toContain(".env");

    fireEvent.click(screen.getByText("批准"));
    await waitFor(() => expect(container.querySelector(".diff-line--add")).toBeTruthy());
    expect(t.respondApproval).toHaveBeenCalledWith("appr-ui-diff", "allow", expect.any(String));
    expect(t.diffWorkspace).toHaveBeenLastCalledWith("src/a.ts", "HEAD", "appr-ui-diff");
  });

  it("拒绝：deny + 错误文案，绝不显示 patch", async () => {
    const t = diffTransport();
    const { container } = render(<FileBrowser transport={t} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(screen.getByText("content of src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("Diff"));
    await waitFor(() => expect(container.querySelector(".decision-tray")).toBeTruthy());

    fireEvent.click(screen.getByText("拒绝"));
    await waitFor(() => expect(screen.getByText(/已拒绝查看敏感文件的差异/)).toBeTruthy());
    expect(container.querySelector(".diff-unified")).toBeNull();
    expect(t.respondApproval).toHaveBeenCalledWith("appr-ui-diff", "deny", expect.any(String));
  });
});

describe("FB-5 选择联动（第三列「差异」靠它绑定当前文件）", () => {
  it("打开文件上报相对路径；返回与换目录上报 null", async () => {
    const onSelectFile = vi.fn();
    render(<FileBrowser transport={transport()} onClose={() => undefined} onSelectFile={onSelectFile} />);
    // 换目录 = 上一层的选中文件不再适用
    fireEvent.click(await screen.findByText("src"));
    await waitFor(() => expect(onSelectFile).toHaveBeenLastCalledWith(null));

    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(onSelectFile).toHaveBeenLastCalledWith("src/a.ts"));

    // 返回：从预览退回列表 ⇒ 当前没有选中文件
    fireEvent.click(screen.getByText("返回"));
    expect(onSelectFile).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("content of src/a.ts")).toBeNull();
  });
});
