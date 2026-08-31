/**
 * 步数计算对标回归测试 — Codex 风格宏观计划步
 *
 * 验证 v1.9.1 步数改造：
 * 1. 侦查类工具（read/glob/grep/tool_search）不推进宏步骤
 * 2. 执行类工具（write/edit/bash/test）才推进宏步骤
 * 3. 步骤标题语义化（中文工具描述）
 */
import { describe, it, expect } from "vitest";
import { AgenticLoop, RECON_TOOL_NAMES } from "../core/llm/agentic-loop";

describe("Codex 风格宏步骤推进 (v1.9.1)", () => {
  it("STEP-001: 侦查类工具被识别为 recon，不推进步骤", () => {
    const reconTools = ["read", "read_file", "glob", "grep", "grep_search", "tool_search", "web_search", "list_directory", "lsp"];
    for (const t of reconTools) {
      expect(AgenticLoop.isReconTool(t)).toBe(true);
    }
  });

  it("STEP-002: 执行类工具不是 recon，会推进步骤", () => {
    const execTools = ["write", "edit", "multi_edit", "bash", "run_test", "install", "subagent", "delegate_to_session"];
    for (const t of execTools) {
      expect(AgenticLoop.isReconTool(t)).toBe(false);
    }
  });

  it("STEP-003: RECON_TOOL_NAMES 包含所有侦查工具", () => {
    expect(RECON_TOOL_NAMES.has("read")).toBe(true);
    expect(RECON_TOOL_NAMES.has("glob")).toBe(true);
    expect(RECON_TOOL_NAMES.has("grep")).toBe(true);
    expect(RECON_TOOL_NAMES.has("tool_search")).toBe(true);
    expect(RECON_TOOL_NAMES.has("write")).toBe(false);
    expect(RECON_TOOL_NAMES.has("bash")).toBe(false);
  });

  it("STEP-004: 工具标题语义化（中文）", () => {
    expect(AgenticLoop.toolDisplayTitle("read")).toBe("读取文件");
    expect(AgenticLoop.toolDisplayTitle("write")).toBe("写入文件");
    expect(AgenticLoop.toolDisplayTitle("edit")).toBe("修改文件");
    expect(AgenticLoop.toolDisplayTitle("bash")).toBe("执行命令");
    expect(AgenticLoop.toolDisplayTitle("run_test")).toBe("运行测试");
    expect(AgenticLoop.toolDisplayTitle("subagent")).toBe("委派子智能体");
  });

  it("STEP-005: 未知工具标题回退为工具名", () => {
    expect(AgenticLoop.toolDisplayTitle("some_unknown_tool")).toBe("some_unknown_tool");
  });

  it("STEP-006: 中间小步骤（recon 工具）不改变总量语义 — 总量固定由计划决定", () => {
    // 关键断言：recon 工具绝不参与宏步骤推进
    // 这保证「读文件 → 搜索 → 看目录」这类中间小步骤不会让用户看到步数跳动
    const reconOnly = ["read", "glob", "grep", "tool_search", "web_search", "list_directory", "lsp", "read_file", "grep_search"];
    for (const t of reconOnly) {
      expect(AgenticLoop.isReconTool(t)).toBe(true);
    }
  });
});
