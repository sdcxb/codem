/**
 * ALLOW：交接正文里的工作区外绝对路径 → 提示加入沙箱允许目录。
 *
 * ## 现场（2026-10-18）
 *
 * 交接里写 `C:/mimo-gui/docs/ui-spec.md`，新会话工作区是 `D:\mimo` ⇒ 沙箱拒绝。
 * 用户要求：**自动提示把该目录加入白名单**，而不是每次都手动去设置里加。
 *
 * 判据：
 * - 抽取/判定是纯函数（ALLOW-1/2）；
 * - 白名单存取、大小写与路径段边界（ALLOW-3）；
 * - 读写闸门与 Rust 写守卫都认同一份白名单（ALLOW-4）；
 * - 提示条真的出现、点一下真的写进设置（ALLOW-5，jsdom 行为）；
 * - 只提示、不自动放行（ALLOW-6）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

vi.mock("../core/i18n/lang", () => ({ useLang: () => "zh", getLang: () => "zh" }));

import {
  extractAbsolutePaths,
  outsideWorkspacePaths,
  requestSandboxAllowlist,
  SANDBOX_ALLOW_REQUEST_EVENT,
} from "../core/session/handoff-sandbox";
import {
  addSandboxAllowedDirs,
  getSandboxAllowedDirs,
  isWithinAllowedDirs,
  removeSandboxAllowedDir,
} from "../core/sandbox/sandbox-acl";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
});

describe("ALLOW 绝对路径抽取与判定", () => {
  it("ALLOW-1: 抽取盘符/UNC 路径，去重、去尾部标点、忽略相对路径", () => {
    const text = [
      "请读 C:/mimo-gui/docs/ui-spec.md，再核对 D:\\mimo\\src\\a.ts。",
      "同一份再写一次 C:/mimo-gui/docs/ui-spec.md。",
      "相对路径 docs/local.md 不算；接口 /v1/models 也不算。",
      "共享盘 \\\\nas\\share\\report.md。",
    ].join("\n");
    const paths = extractAbsolutePaths(text);
    expect(paths).toContain("C:/mimo-gui/docs/ui-spec.md");
    expect(paths).toContain("D:\\mimo\\src\\a.ts");
    expect(paths).toContain("\\\\nas\\share\\report.md");
    expect(paths.filter((p) => p.includes("ui-spec.md")), "重复路径只留一条").toHaveLength(1);
    expect(paths.some((p) => p.includes("docs/local.md"))).toBe(false);
    expect(paths.some((p) => p === "/v1/models")).toBe(false);
  });

  it("ALLOW-2: 只挑工作区外且未被允许的；路径段边界要正确", () => {
    const workspace = "D:\\mimo";
    const inside = "D:/mimo/docs/a.md";
    const sibling = "D:/mimo2/docs/a.md";
    const outside = "C:/mimo-gui/docs/ui-spec.md";
    const allowedDir = "C:/mimo-gui";

    expect(outsideWorkspacePaths([inside], workspace, [])).toEqual([]);
    expect(outsideWorkspacePaths([sibling], workspace, [])).toEqual([
      "D:/mimo2/docs/a.md",
    ]);
    expect(outsideWorkspacePaths([outside], workspace, [])).toEqual([
      "C:/mimo-gui/docs/ui-spec.md",
    ]);
    expect(
      outsideWorkspacePaths([outside], workspace, [allowedDir]),
      "已在允许目录里 ⇒ 不再提示",
    ).toEqual([]);
  });
});

describe("ALLOW-3 白名单存取", () => {
  it("ALLOW-3: 加入去重、规范化；命中按路径段判；可移除", () => {
    expect(getSandboxAllowedDirs()).toEqual([]);
    expect(addSandboxAllowedDirs(["C:\\mimo-gui\\"])).toEqual(["C:/mimo-gui"]);
    expect(addSandboxAllowedDirs(["c:/MIMO-GUI"]), "大小写不同视为已存在").toEqual([]);
    expect(getSandboxAllowedDirs()).toEqual(["C:/mimo-gui"]);
    expect(isWithinAllowedDirs("C:/mimo-gui/docs/x.md", ["C:/mimo-gui"])).toBe(true);
    expect(isWithinAllowedDirs("C:\\mimo-gui\\src\\a.ts", ["c:\\MIMO-GUI\\"])).toBe(true);
    expect(isWithinAllowedDirs("C:/mimo-gui2/x", ["C:/mimo-gui"]), "不许前缀误伤").toBe(false);
    removeSandboxAllowedDir("C:/mimo-gui");
    expect(getSandboxAllowedDirs()).toEqual([]);
  });
});

describe("ALLOW-4 闸门与 Rust 守卫都认白名单", () => {
  it("ALLOW-4: file-api / tools / Rust 三处都有 allowed_roots 逻辑", () => {
    const fileApi = read("src/core/file-api.ts");
    expect(fileApi).toContain("isWithinAllowedDirs(target, getSandboxAllowedDirs())");
    expect(fileApi).toContain("allowed_roots: sandboxEnabled ? getSandboxAllowedDirs() : []");
    const tools = read("src/core/llm/tools.ts");
    expect(tools).toContain("isWithinAllowedDirs(resolvedPath, getSandboxAllowedDirs())");
    // 工具管线在**进工具之前**还有一道路径闸（read 的越界就是被它拦的）
    const pipeline = read("src/core/llm/tool-pipeline.ts");
    expect(pipeline).toContain("isWithinAllowedDirs(resolvedPath)");
    expect(pipeline, "命令文本里的越界路径也要认白名单").toContain("isWithinWorkspace(p, ws) || isWithinAllowedDirs(p)");
    const rust = read("src-tauri/src/lib.rs");
    expect(rust).toContain("allowed_roots: Option<Vec<String>>");
    expect(rust).toContain("for root in allowed_roots.unwrap_or(&[])");
  });
});

describe("ALLOW-7 允许目录可管理（设置里能移除）", () => {
  it("ALLOW-7: 设置面板列出允许目录并可移除（不是只进不出）", () => {
    const src = read("src/components/SettingsPanel.tsx");
    expect(src).toContain("getSandboxAllowedDirs");
    expect(src).toContain("removeSandboxAllowedDir(dir)");
    expect(src).toContain("sp-allowlist");
    expect(src).toContain("从允许目录移除");
    // 样式必须存在（否则列表不可见，等于没做）
    expect(read("src/styles/codem-ui.css")).toContain(".sp-allowlist-item");
  });
});

describe("ALLOW-5 提示条（行为）", () => {
  it("ALLOW-5: 事件出现提示条；点「加入允许目录」真的写进设置", async () => {
    const { SandboxAllowPrompt } = await import("../components/SandboxAllowPrompt");
    render(<SandboxAllowPrompt />);

    window.dispatchEvent(
      new CustomEvent(SANDBOX_ALLOW_REQUEST_EVENT, {
        detail: { paths: ["C:/mimo-gui/docs/ui-spec.md"] },
      }),
    );
    const prompt = await screen.findByTestId("sandbox-allow-prompt");
    expect(prompt.textContent).toContain("1 个");
    expect(getSandboxAllowedDirs(), "提示出现时还不能放行（必须等用户点确认）").toEqual([]);

    fireEvent.click(screen.getByText("加入允许目录"));
    await waitFor(() => {
      expect(getSandboxAllowedDirs()).toContain("C:/mimo-gui/docs");
    });
    await screen.findByTestId("sandbox-allow-done");
  });
});

describe("ALLOW-6 只提示，不自动放行", () => {
  it("ALLOW-6: 工作区内不发提示；工作区外只发事件，不写白名单", () => {
    expect(requestSandboxAllowlist("读 D:/mimo/docs/a.md", "D:\\mimo")).toBe(false);
    expect(getSandboxAllowedDirs()).toEqual([]);

    const seen: string[][] = [];
    const onReq = (e: Event) => seen.push((e as CustomEvent<{ paths: string[] }>).detail.paths);
    window.addEventListener(SANDBOX_ALLOW_REQUEST_EVENT, onReq);
    expect(requestSandboxAllowlist("读 C:/mimo-gui/docs/ui-spec.md", "D:\\mimo")).toBe(true);
    window.removeEventListener(SANDBOX_ALLOW_REQUEST_EVENT, onReq);
    expect(seen).toEqual([["C:/mimo-gui/docs/ui-spec.md"]]);
    expect(getSandboxAllowedDirs(), "发提示不等于放行").toEqual([]);
  });
});
