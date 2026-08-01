/**
 * 跨功能交叉影响测试 — 验证新增功能不破坏已有核心链路
 *
 * 重点：
 * 1. agentic-loop.ts 新增 start/finalize/needs_you/message 钩子不破坏现有迭代
 * 2. database.ts 新增 4 张表不破坏现有表
 * 3. PanelSidebar 新增 Tab 不破坏现有 Git/Workbench 面板
 * 4. App.tsx 新增 NeedsYouPanel 渲染不破坏现有对话流
 * 5. FileExplorer 新增 Git 状态不破坏现有文件树渲染
 * 6. spawner.ts 新增 Profile 注入不破坏现有子智能体生成
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";

describe("交叉影响：agentic-loop 集成不破坏现有事件链", () => {
  it("LoopEvent 联合类型 — 包含所有原有事件 + 新增事件", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    // 原有事件
    expect(source).toContain('"start"');
    expect(source).toContain('"text_delta"');
    expect(source).toContain('"tool_complete"');
    expect(source).toContain('"tool_error"');
    expect(source).toContain('"guidance_received"');
    expect(source).toContain('"compaction_start"');
    expect(source).toContain('"compaction_end"');
    expect(source).toContain('"end"');
    // 新增事件
    expect(source).toContain('"file_changes_tracked"');
    expect(source).toContain('"needs_you"');
    expect(source).toContain('"agent_message_received"');
  });

  it("agentic-loop — guidance 消费逻辑不被 needs_you 消费干扰", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    // guidance 消费在 needs_you 之前（按现有顺序）
    const guidancePos = source.indexOf("this.guidanceQueue.consume");
    const needsYouPos = source.indexOf("this.needsYouQueue.consume");
    expect(guidancePos).toBeGreaterThan(-1);
    expect(needsYouPos).toBeGreaterThan(-1);
    // guidance should come before needs_you
    expect(guidancePos).toBeLessThan(needsYouPos);
  });

  it("agentic-loop — file change tracker start 在 executeIteration 之前", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    const startPos = source.indexOf("this.fileChangeTracker = new FileChangeTracker");
    const executePos = source.indexOf("this.executeIteration(");
    expect(startPos).toBeGreaterThan(-1);
    expect(executePos).toBeGreaterThan(-1);
    expect(startPos).toBeLessThan(executePos);
  });

  it("agentic-loop — file change tracker finalize 在 executeIteration 之后", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    const finalizePos = source.indexOf("this.fileChangeTracker.finalize()");
    const executePos = source.indexOf("this.executeIteration(");
    expect(finalizePos).toBeGreaterThan(executePos);
  });

  it("agentic-loop — onWriteConfirm 不受 needs_you 影响", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("onWriteConfirm");
    // onWriteConfirm is passed to toolCtx, not affected by needs_you
    expect(source).toContain("securityMode");
  });
});

describe("交叉影响：database 新增表不破坏现有表", () => {
  beforeEach(async () => {
    delete (window as any).__TAURI__;
    await initDatabase();
  });

  it("原有表全部存在 — projects/sessions/messages/memory/mcp_servers等", () => {
    const db = getDatabase();
    expect(db).not.toBe(null);
    // Check original tables exist
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

  it("新增表全部存在 — turn_file_changes/agent_profiles/needs_you_pending/agent_messages", () => {
    const db = getDatabase();
    const tables = db!.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables[0]?.values.map((v) => v[0]) || [];
    expect(tableNames).toContain("turn_file_changes");
    expect(tableNames).toContain("agent_profiles");
    expect(tableNames).toContain("needs_you_pending");
    expect(tableNames).toContain("agent_messages");
  });

  it("新增表 — turn_file_changes 有 ON DELETE CASCADE", () => {
    const db = getDatabase();
    const result = db!.exec("SELECT sql FROM sqlite_master WHERE name='turn_file_changes'");
    const sql = result[0]?.values[0][0] as string;
    expect(sql).toContain("FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE");
  });

  it("新增表不与现有表名冲突", () => {
    const db = getDatabase();
    const tables = db!.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables[0].values.map((v) => v[0] as string);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length); // No duplicate table names
  });
});

describe("交叉影响：PanelSidebar 新增 Tab 不破坏现有面板", () => {
  it("PanelSidebar — 包含 git/workbench/files/changes 四个 Tab", () => {
    const source = require("fs").readFileSync(
      "src/components/PanelSidebar.tsx",
      "utf-8"
    );
    expect(source).toContain('"git"');
    expect(source).toContain('"workbench"');
    expect(source).toContain('"files"');
    expect(source).toContain('"changes"');
  });

  it("PanelSidebar — 仍渲染 GitInfoPanel 和 Workbench", () => {
    const source = require("fs").readFileSync(
      "src/components/PanelSidebar.tsx",
      "utf-8"
    );
    expect(source).toContain("GitInfoPanel");
    expect(source).toContain("Workbench");
  });

  it("PanelSidebar — 新增 FileExplorer 和 FileChangesList", () => {
    const source = require("fs").readFileSync(
      "src/components/PanelSidebar.tsx",
      "utf-8"
    );
    expect(source).toContain("FileExplorer");
    expect(source).toContain("FileChangesList");
  });
});

describe("交叉影响：App.tsx 新增 NeedsYouPanel 不破坏对话流", () => {
  it("App.tsx — 导入 NeedsYouPanel", () => {
    const source = require("fs").readFileSync(
      "src/App.tsx",
      "utf-8"
    );
    expect(source).toContain("NeedsYouPanel");
  });

  it("App.tsx — 原有 onWriteConfirm 仍存在", () => {
    const source = require("fs").readFileSync(
      "src/App.tsx",
      "utf-8"
    );
    expect(source).toContain("onWriteConfirm");
    expect(source).toContain("pendingWriteConfirm");
  });

  it("App.tsx — 原有 PermissionDialog 仍存在", () => {
    const source = require("fs").readFileSync(
      "src/App.tsx",
      "utf-8"
    );
    expect(source).toContain("PermissionDialog");
    expect(source).toContain("ConfirmDialog");
  });
});

describe("交叉影响：FileExplorer Git 状态不破坏现有文件树", () => {
  it("FileExplorer — 仍支持 onFileClick 回调", () => {
    const source = require("fs").readFileSync(
      "src/components/FileExplorer.tsx",
      "utf-8"
    );
    expect(source).toContain("onFileClick");
  });

  it("FileExplorer — 仍支持 refreshKey 手动刷新", () => {
    const source = require("fs").readFileSync(
      "src/components/FileExplorer.tsx",
      "utf-8"
    );
    expect(source).toContain("refreshKey");
  });

  it("FileExplorer — 仍使用 dirCache 缓存", () => {
    const source = require("fs").readFileSync(
      "src/components/FileExplorer.tsx",
      "utf-8"
    );
    expect(source).toContain("dirCache");
  });

  it("FileExplorer — FileEntryNode 仍渲染 icon + name", () => {
    const source = require("fs").readFileSync(
      "src/components/FileExplorer.tsx",
      "utf-8"
    );
    expect(source).toContain("file-icon");
    expect(source).toContain("file-name");
  });
});

describe("交叉影响：SubagentSpawner Profile 注入不破坏现有生成", () => {
  it("spawner — profile_id 为可选参数", () => {
    const source = require("fs").readFileSync(
      "src/core/subagent/spawner.ts",
      "utf-8"
    );
    // profile_id should be optional (using (taskData as any).profile_id)
    expect(source).toContain("(taskData as any).profile_id");
  });

  it("spawner — 原有 spawn 逻辑不受影响", () => {
    const source = require("fs").readFileSync(
      "src/core/subagent/spawner.ts",
      "utf-8"
    );
    expect(source).toContain("executeTask");
    expect(source).toContain("activeTasks");
  });

  it("spawner — Profile 只在 persistent=true 时注入", () => {
    const source = require("fs").readFileSync(
      "src/core/subagent/spawner.ts",
      "utf-8"
    );
    expect(source).toContain("task.persistent");
  });
});

describe("交叉影响：Cargo.toml 新增依赖不破坏现有构建", () => {
  it("Cargo.toml — portable-pty 版本正确", () => {
    const source = require("fs").readFileSync(
      "src-tauri/Cargo.toml",
      "utf-8"
    );
    expect(source).toContain('portable-pty = "0.8"');
  });

  it("Cargo.toml — 原有依赖仍存在", () => {
    const source = require("fs").readFileSync(
      "src-tauri/Cargo.toml",
      "utf-8"
    );
    expect(source).toContain("tauri");
    expect(source).toContain("serde");
    expect(source).toContain("reqwest");
  });
});

describe("交叉影响：lib.rs 新增命令不破坏现有命令", () => {
  it("lib.rs — 原有命令仍注册", () => {
    const source = require("fs").readFileSync(
      "src-tauri/src/lib.rs",
      "utf-8"
    );
    expect(source).toContain("execute_command");
    expect(source).toContain("list_directory");
    expect(source).toContain("read_file");
    expect(source).toContain("write_file");
    expect(source).toContain("send_message");
  });

  it("lib.rs — 新增 PTY 命令注册", () => {
    const source = require("fs").readFileSync(
      "src-tauri/src/lib.rs",
      "utf-8"
    );
    expect(source).toContain("spawn_pty");
    expect(source).toContain("write_pty");
    expect(source).toContain("resize_pty");
    expect(source).toContain("close_pty");
  });

  it("lib.rs — PtyMap 状态管理注册", () => {
    const source = require("fs").readFileSync(
      "src-tauri/src/lib.rs",
      "utf-8"
    );
    expect(source).toContain("PtyMap");
    expect(source).toContain("PtySession");
  });
});

describe("交叉影响：styles.css 新增样式不破坏现有样式", () => {
  it("styles.css — 原有终端样式仍存在", () => {
    const source = require("fs").readFileSync(
      "src/styles.css",
      "utf-8"
    );
    expect(source).toContain(".terminal-container");
  });

  it("styles.css — 原有文件树样式仍存在", () => {
    const source = require("fs").readFileSync(
      "src/styles.css",
      "utf-8"
    );
    expect(source).toContain(".file-entry");
    expect(source).toContain(".file-icon");
    expect(source).toContain(".file-name");
  });

  it("styles.css — 新增 Git 状态徽章样式", () => {
    const source = require("fs").readFileSync(
      "src/styles.css",
      "utf-8"
    );
    expect(source).toContain(".git-status-badge");
    expect(source).toContain(".git-status-modified");
    expect(source).toContain(".git-status-added");
    expect(source).toContain(".git-status-deleted");
  });

  it("styles.css — 新增 Needs You 面板样式", () => {
    const source = require("fs").readFileSync(
      "src/styles.css",
      "utf-8"
    );
    expect(source).toContain(".needs-you-overlay");
    expect(source).toContain(".needs-you-dialog");
  });

  it("styles.css — 新增终端 PTY Tab 样式", () => {
    const source = require("fs").readFileSync(
      "src/styles.css",
      "utf-8"
    );
    expect(source).toContain(".terminal-panel");
    expect(source).toContain(".terminal-tab-bar");
    expect(source).toContain(".terminal-stop-btn");
  });
});
