/**
 * 文件树显示隐藏文件夹回归测试 (v1.9.1)
 *
 * 验证：FileExplorer 通过 Tauri list_directory 请求时传递 showHidden: true，
 * 使 .wecode-ref 等点开头目录在文件树中可见（LLM 工具的 listDirectory 不传，
 * 仍保持隐藏过滤）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fileExplorerSrc = readFileSync(join(__dirname, "../components/FileExplorer.tsx"), "utf-8");

describe("文件树显示隐藏文件夹 (v1.9.1)", () => {
  it("FILE-TREE-001: FileExplorer 调用 list_directory 时传 showHidden: true", () => {
    expect(fileExplorerSrc).toContain('invoke("list_directory", { path, showHidden: true })');
  });

  it("FILE-TREE-002: 注释说明 LLM 工具调用仍保持隐藏过滤", () => {
    expect(fileExplorerSrc).toContain("LLM 工具调用的 listDirectory (file-api.ts) 不传此参数");
  });

  it("FILE-TREE-003: Rust list_directory 签名含 show_hidden 参数", () => {
    const rustSrc = readFileSync(join(__dirname, "../../src-tauri/src/lib.rs"), "utf-8");
    expect(rustSrc).toContain("async fn list_directory(path: String, show_hidden: Option<bool>)");
    expect(rustSrc).toContain("if (!show_hidden && name.starts_with('.')) || name == \"node_modules\"");
  });

  it("FILE-TREE-004: 文件树入口统一复用 FileExplorer 组件", () => {
    // RightSidebar 和 PanelSidebar 的文件树都通过 FileExplorer 渲染
    const rightSidebar = readFileSync(join(__dirname, "../components/RightSidebar.tsx"), "utf-8");
    const panelSidebar = readFileSync(join(__dirname, "../components/PanelSidebar.tsx"), "utf-8");
    expect(rightSidebar).toContain('<FileExplorer');
    expect(panelSidebar).toContain('<FileExplorer');
  });
});
