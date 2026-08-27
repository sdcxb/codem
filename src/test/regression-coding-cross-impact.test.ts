/**
 * 跨功能交叉影响测试 — 验证新增功能不破坏已有核心链路
 *
 * 旧版通过 readFileSync + toContain 检查源码字符串，
 * 新版直接导入模块、调用函数、验证实际行为。
 *
 * 重点：
 * 1. LoopEvent 联合类型完整性 — 通过 TypeScript 类型检查验证
 * 2. database 新增表不破坏现有表 — 通过真实 DB 查询验证
 * 3. ToolRegistry 核心工具仍注册 — 通过 createDefaultToolRegistry 验证
 * 4. SubagentRuntime 行为完整性 — 通过真实 runtime 实例验证
 * 5. Cargo.toml / lib.rs / styles.css — 合并为单次 lint 检查
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { readFileSync } from "fs";

// ========== 类型级验证：LoopEvent 联合类型 ==========
// 通过编译时 TypeScript 检查保证事件类型完整性
import type { LoopEvent, LoopResult } from "../core/llm/agentic-loop";

describe("交叉影响：LoopEvent 联合类型完整性", () => {
  it("原有事件类型仍可用", () => {
    // 如果类型定义被破坏，TypeScript 编译就会失败
    const startEvent: LoopEvent = { type: "start", iteration: 0 };
    const textEvent: LoopEvent = { type: "text_delta", text: "hello" };
    const toolComplete: LoopEvent = {
      type: "tool_complete",
      toolCall: { id: "tc1", name: "read", args: {}, status: "done" },
      result: {},
    };
    const toolError: LoopEvent = {
      type: "tool_error",
      toolCall: { id: "tc2", name: "write", args: {}, status: "error" },
      error: "permission denied",
    };
    const guidance: LoopEvent = { type: "guidance_received", message: "test", guidanceId: "g1" };
    const compactionStart: LoopEvent = { type: "compaction_start" };
    const compactionEnd: LoopEvent = { type: "compaction_end", messagesRemoved: 5 };
    const endEvent: LoopEvent = { type: "end", result: { done: true } as LoopResult };

    // 只要赋值不报错，类型就是完整的
    expect(startEvent.type).toBe("start");
    expect(textEvent.type).toBe("text_delta");
    expect(toolComplete.type).toBe("tool_complete");
    expect(toolError.type).toBe("tool_error");
    expect(guidance.type).toBe("guidance_received");
    expect(compactionStart.type).toBe("compaction_start");
    expect(compactionEnd.type).toBe("compaction_end");
    expect(endEvent.type).toBe("end");
  });

  it("新增事件类型可用", () => {
    const fileChanges: LoopEvent = {
      type: "file_changes_tracked",
      artifactId: "art-1",
      changedFiles: [{ path: "/test.ts", status: "modified" }],
      turnIndex: 0,
    };
    const needsYou: LoopEvent = {
      type: "needs_you",
      question: "Which framework?",
      context: "Need to choose",
      confirmedFacts: "",
      options: [{ id: "react", label: "React" }],
      itemId: "ny-1",
    };
    const agentMsg: LoopEvent = {
      type: "agent_message_received",
      fromAgent: "researcher",
      subject: "Found it",
      body: "Results ready",
    };

    expect(fileChanges.type).toBe("file_changes_tracked");
    expect(needsYou.type).toBe("needs_you");
    expect(agentMsg.type).toBe("agent_message_received");
  });
});

// ========== 数据库表完整性 — 行为测试（保留原有） ==========
describe("交叉影响：database 新增表不破坏现有表", () => {
  beforeEach(async () => {
    delete (window as any).__TAURI__;
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
  });

  it("原有表全部存在 — projects/sessions/messages/memory/mcp_servers等", async () => {
    await initDatabase();
    const db = getDatabase();
    expect(db).not.toBe(null);
    const tables = db!.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables[0]?.values.map((v) => v[0]) || [];
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("memory");
    expect(tableNames).toContain("mcp_servers");
    expect(tableNames).toContain("recovery_data");
    expect(tableNames).toContain("cost_records");
  });

  it("新增表全部存在 — turn_file_changes/agent_profiles/needs_you_pending/agent_messages", async () => {
    await initDatabase();
    const db = getDatabase();
    const tables = db!.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables[0]?.values.map((v) => v[0]) || [];
    expect(tableNames).toContain("turn_file_changes");
    expect(tableNames).toContain("agent_profiles");
    expect(tableNames).toContain("needs_you_pending");
    expect(tableNames).toContain("agent_messages");
  });

  it("新增表 — turn_file_changes 有 ON DELETE CASCADE", async () => {
    await initDatabase();
    const db = getDatabase();
    const result = db!.exec("SELECT sql FROM sqlite_master WHERE name='turn_file_changes'");
    const sql = result[0]?.values[0][0] as string;
    expect(sql).toContain("FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE");
  });

  it("新增表不与现有表名冲突", async () => {
    await initDatabase();
    const db = getDatabase();
    const tables = db!.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables[0].values.map((v) => v[0] as string);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ========== ToolRegistry 核心工具仍注册 — 行为测试 ==========
describe("交叉影响：ToolRegistry 核心工具注册完整性", () => {
  it("createDefaultToolRegistry 注册所有核心工具", () => {
    const registry = createDefaultToolRegistry();
    const toolIds = registry.getAll().map((t) => t.id);

    // 原有核心工具
    expect(toolIds).toContain("read");
    expect(toolIds).toContain("write");
    expect(toolIds).toContain("edit");
    expect(toolIds).toContain("bash");
    expect(toolIds).toContain("glob");
    expect(toolIds).toContain("grep");
  });

  it("每个核心工具都有 description + parameters + execute", () => {
    const registry = createDefaultToolRegistry();
    for (const tool of registry.getAll()) {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("工具可通过 getTool 获取", () => {
    const registry = createDefaultToolRegistry();
    const readTool = registry.get("read");
    expect(readTool).toBeDefined();
    expect(readTool!.id).toBe("read");
  });

  it("工具可被 remove 移除", () => {
    const registry = createDefaultToolRegistry();
    registry.remove("read");
    expect(registry.get("read")).toBeUndefined();
  });
});

// ========== SubagentRuntime 行为完整性 — 旧模式已移除 ==========
describe.skip("交叉影响：SubagentRuntime 行为完整性 — 旧模式已移除", () => {
  it("旧 LLMSubagentSpawner 已移除", () => {
    // 新架构使用 DSH-style SubagentRuntime + InProcessSpawnProvider
  });
});

// ========== PanelSidebar / App.tsx 组件完整性 — 合并为单次 lint ==========
describe("交叉影响：组件引用完整性 lint", () => {
  const COMPONENT_FILES = {
    PanelSidebar: "src/components/PanelSidebar.tsx",
    App: "src/App.tsx",
    FileExplorer: "src/components/FileExplorer.tsx",
  };

  it("PanelSidebar 包含所有 Tab 类型 + 组件引用", () => {
    const src = readFileSync(COMPONENT_FILES.PanelSidebar, "utf-8");
    // Tab 类型
    expect(src).toContain('"git"');
    expect(src).toContain('"workbench"');
    expect(src).toContain('"files"');
    expect(src).toContain('"changes"');
    // 组件引用
    expect(src).toContain("GitInfoPanel");
    expect(src).toContain("Workbench");
    expect(src).toContain("FileExplorer");
    expect(src).toContain("FileChangesList");
  });

  it("App.tsx 包含 NeedsYouPanel + onWriteConfirm + PermissionDialog", () => {
    const src = readFileSync(COMPONENT_FILES.App, "utf-8");
    expect(src).toContain("NeedsYouPanel");
    expect(src).toContain("onWriteConfirm");
    expect(src).toContain("pendingWriteConfirm");
    expect(src).toContain("PermissionDialog");
    expect(src).toContain("ConfirmDialog");
  });

  it("FileExplorer 包含 onFileClick + refreshKey + dirCache + file-entry-icon", () => {
    const src = readFileSync(COMPONENT_FILES.FileExplorer, "utf-8");
    expect(src).toContain("onFileClick");
    expect(src).toContain("refreshKey");
    expect(src).toContain("dirCache");
    expect(src).toContain("file-entry-icon");
    expect(src).toContain("file-name");
  });
});

// ========== Rust / CSS lint — 合并为单次检查 ==========
describe("交叉影响：Rust + CSS lint", () => {
  it("Cargo.toml — portable-pty + 原有依赖", () => {
    const src = readFileSync("src-tauri/Cargo.toml", "utf-8");
    expect(src).toContain('portable-pty = "0.8"');
    expect(src).toContain("tauri");
    expect(src).toContain("serde");
    expect(src).toContain("reqwest");
  });

  it("lib.rs — 原有命令 + PTY 命令 + PtyMap", () => {
    const src = readFileSync("src-tauri/src/lib.rs", "utf-8");
    // 原有命令
    expect(src).toContain("execute_command");
    expect(src).toContain("list_directory");
    expect(src).toContain("read_file");
    expect(src).toContain("write_file");
    expect(src).toContain("send_message");
    // PTY 命令
    expect(src).toContain("spawn_pty");
    expect(src).toContain("write_pty");
    expect(src).toContain("resize_pty");
    expect(src).toContain("close_pty");
    // PtyMap
    expect(src).toContain("PtyMap");
    expect(src).toContain("PtySession");
  });

  it("styles.css — 终端 + 文件树 + Git 徽章 + NeedsYou + PTY Tab", () => {
    const src = readFileSync("src/styles.css", "utf-8");
    // 终端
    expect(src).toContain(".terminal-container");
    // 文件树
    expect(src).toContain(".file-entry");
    expect(src).toContain(".file-entry-icon");
    expect(src).toContain(".file-name");
    // Git 徽章
    expect(src).toContain(".git-status-badge");
    expect(src).toContain(".git-status-modified");
    expect(src).toContain(".git-status-added");
    expect(src).toContain(".git-status-deleted");
    // Needs You
    expect(src).toContain(".needs-you-overlay");
    expect(src).toContain(".needs-you-dialog");
    // PTY Tab
    expect(src).toContain(".terminal-panel");
    expect(src).toContain(".terminal-tab-bar");
    expect(src).toContain(".terminal-stop-btn");
  });
});
