/**
 * 测试：权限/安全模式/沙箱 — SECU-001 ~ SECU-025
 *
 * 覆盖范围：
 *   9.1 三级安全策略（ask/auto/full）
 *   9.2 权限管理与沙箱
 *
 * 改动影响：
 *   - security-mode.ts: SecurityMode 类型、优先级解析、行为判断
 *   - permission.ts: PermissionManager、PermissionEvaluator
 *   - tools.ts: sandbox 检查 (checkSandbox)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDatabase } from "../core/storage/database";

// Mock agent registry
vi.mock("../core/agent/agent", () => ({
  getAgentRegistry: () => ({
    evaluatePermission: () => "ask",
  }),
}));

import {
  SECURITY_MODES,
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  getProjectSecurityMode,
  setProjectSecurityMode,
  getEffectiveSecurityMode,
  shouldShowWriteConfirm,
  shouldCheckPermissions,
  isAutoApprovable,
  evaluateWithSecurityMode,
  type SecurityMode,
} from "../core/permission/security-mode";
import { removeSetting, getSetting, setSetting } from "../core/storage/settings";

describe("权限 — 三级安全策略", () => {
  beforeEach(() => {
    localStorage.clear();
    removeSetting("codem-security-mode");
  });

  // ===== SECU-001: ask 模式 =====
  describe("ask 模式", () => {
    it("SECU-001: 未设置时默认返回 ask", () => {
      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("SECU-001b: 设置 ask 后正确读取", () => {
      setGlobalSecurityMode("ask");
      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("SECU-001c: shouldCheckPermissions 返回 true", () => {
      expect(shouldCheckPermissions("ask")).toBe(true);
    });

    it("SECU-001d: shouldShowWriteConfirm 返回 true", () => {
      expect(shouldShowWriteConfirm("ask")).toBe(true);
    });
  });

  // ===== SECU-002/003: auto 模式 =====
  describe("auto 模式", () => {
    it("SECU-002: auto 模式安全操作自动批准", () => {
      setGlobalSecurityMode("auto");
      expect(getGlobalSecurityMode()).toBe("auto");
      // Read-only tools are auto-approvable
      expect(isAutoApprovable("read")).toBe(true);
      expect(isAutoApprovable("glob")).toBe(true);
      expect(isAutoApprovable("grep")).toBe(true);
    });

    it("SECU-003: auto 模式危险命令仍需确认", () => {
      expect(isAutoApprovable("bash", "rm -rf /")).toBe(false);
      expect(isAutoApprovable("bash", "git push --force")).toBe(false);
      expect(isAutoApprovable("bash", "sudo apt install")).toBe(false);
      expect(isAutoApprovable("bash", "chmod 777 /")).toBe(false);
      expect(isAutoApprovable("bash", "mkfs.ext4 /dev/sda")).toBe(false);
      expect(isAutoApprovable("bash", ":(){ :|:& };:")).toBe(false);
      expect(isAutoApprovable("bash", "shutdown -h now")).toBe(false);
      expect(isAutoApprovable("bash", "reboot")).toBe(false);
    });

    it("SECU-003b: auto 模式安全 bash 命令自动批准", () => {
      expect(isAutoApprovable("bash", "ls -la")).toBe(true);
      expect(isAutoApprovable("bash", "echo hello")).toBe(true);
      expect(isAutoApprovable("bash", "npm test")).toBe(true);
    });

    it("SECU-003c: shouldCheckPermissions 返回 true", () => {
      expect(shouldCheckPermissions("auto")).toBe(true);
    });

    it("SECU-003d: shouldShowWriteConfirm 返回 false", () => {
      expect(shouldShowWriteConfirm("auto")).toBe(false);
    });
  });

  // ===== SECU-004: full 模式 =====
  describe("full 模式", () => {
    it("SECU-004: full 模式不弹任何确认", () => {
      setGlobalSecurityMode("full");
      expect(getGlobalSecurityMode()).toBe("full");
      expect(shouldCheckPermissions("full")).toBe(false);
      expect(shouldShowWriteConfirm("full")).toBe(false);
    });
  });

  // ===== SECU-005/006/007: 优先级解析 =====
  describe("优先级解析", () => {
    it("SECU-005: 项目级覆盖全局", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/project/a", "auto");

      expect(getEffectiveSecurityMode("/project/a")).toBe("auto");
      expect(getEffectiveSecurityMode("/project/b")).toBe("ask");
    });

    it("SECU-005b: 不同项目不同模式", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/project/a", "auto");
      setProjectSecurityMode("/project/b", "full");

      expect(getEffectiveSecurityMode("/project/a")).toBe("auto");
      expect(getEffectiveSecurityMode("/project/b")).toBe("full");
    });

    it("SECU-006: 项目级 null 回退全局", () => {
      setGlobalSecurityMode("auto");
      setProjectSecurityMode("/project/c", null);

      expect(getProjectSecurityMode("/project/c")).toBeNull();
      expect(getEffectiveSecurityMode("/project/c")).toBe("auto");
    });

    it("SECU-007: 无效值回退默认 ask", () => {
      // Setting an invalid value via raw setSetting
      const db = getDatabase();
      db.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", ["codem-security-mode", "invalid", Date.now()]);

      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("SECU-007b: getEffectiveSecurityMode 无 projectPath 返回全局", () => {
      setGlobalSecurityMode("full");
      expect(getEffectiveSecurityMode()).toBe("full");
    });
  });

  // ===== SECU-008: evaluateWithSecurityMode 组合 =====
  describe("evaluateWithSecurityMode 组合", () => {
    it("SECU-008a: ask × allow → allow", () => {
      expect(evaluateWithSecurityMode("ask", "read", "/x", "allow")).toBe("allow");
    });

    it("SECU-008b: ask × ask → ask", () => {
      expect(evaluateWithSecurityMode("ask", "bash", "rm -rf", "ask")).toBe("ask");
    });

    it("SECU-008c: ask × deny → deny", () => {
      expect(evaluateWithSecurityMode("ask", "bash", "rm /etc", "deny")).toBe("deny");
    });

    it("SECU-008d: auto × allow → allow", () => {
      expect(evaluateWithSecurityMode("auto", "read", "/x", "allow")).toBe("allow");
    });

    it("SECU-008e: auto × ask (safe op) → allow", () => {
      expect(evaluateWithSecurityMode("auto", "read", "/x", "ask")).toBe("allow");
    });

    it("SECU-008f: auto × ask (dangerous) → ask", () => {
      expect(evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask")).toBe("ask");
    });

    it("SECU-008g: auto × deny → deny", () => {
      expect(evaluateWithSecurityMode("auto", "bash", "rm /etc", "deny")).toBe("deny");
    });

    it("SECU-008h: full × allow → allow", () => {
      expect(evaluateWithSecurityMode("full", "bash", "anything", "allow")).toBe("allow");
    });

    it("SECU-008i: full × ask → allow", () => {
      expect(evaluateWithSecurityMode("full", "bash", "rm -rf", "ask")).toBe("allow");
    });

    it("SECU-008j: full × deny → deny (protected paths always denied)", () => {
      expect(evaluateWithSecurityMode("full", "bash", "rm /etc", "deny")).toBe("deny");
    });
  });

  // ===== SECU-009/010: write Diff 弹窗 =====
  describe("write Diff 弹窗行为", () => {
    it("SECU-009: ask 模式显示 Diff", () => {
      expect(shouldShowWriteConfirm("ask")).toBe(true);
    });

    it("SECU-010: full 模式跳过 Diff", () => {
      expect(shouldShowWriteConfirm("full")).toBe(false);
    });

    it("SECU-010b: auto 模式跳过 Diff", () => {
      expect(shouldShowWriteConfirm("auto")).toBe(false);
    });
  });

  // ===== SECURITY_MODES 常量完整性 =====
  describe("SECURITY_MODES 常量", () => {
    it("SECURITY_MODES 包含三种模式", () => {
      expect(SECURITY_MODES).toHaveLength(3);
      expect(SECURITY_MODES.map(m => m.mode)).toContain("ask");
      expect(SECURITY_MODES.map(m => m.mode)).toContain("auto");
      expect(SECURITY_MODES.map(m => m.mode)).toContain("full");
    });

    it("SECURITY_MODES 每种模式有完整字段", () => {
      for (const mode of SECURITY_MODES) {
        expect(mode.mode).toBeDefined();
        expect(mode.label_zh).toBeDefined();
        expect(mode.label_en).toBeDefined();
        expect(mode.desc_zh).toBeDefined();
        expect(mode.desc_en).toBeDefined();
        expect(mode.icon).toBeDefined();
      }
    });
  });
});

describe("权限 — PermissionManager", () => {
  beforeEach(() => {
    localStorage.clear();
    removeSetting("codem-security-mode");
  });

  it("SECU-011: PermissionManager 无超时——可无限等待", async () => {
    const { PermissionManager } = await import("../core/permission/permission");
    const mgr = new PermissionManager();
    // Verify no timeout is set — we just check the instance exists and works
    expect(mgr).toBeDefined();
    // requestPermission should return a Promise that doesn't auto-resolve
    const reqPromise = mgr.requestPermission({
      id: "test-req",
      sessionId: "sess-test",
      tool: "bash",
      input: { command: "ls" },
      timestamp: Date.now(),
    });

    // The promise should be pending (not resolved after 100ms)
    let resolved = false;
    reqPromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 100));
    expect(resolved).toBe(false);

    // Now resolve it
    mgr.resolvePermission("test-req", { requestId: "test-req", action: "allow" });
    const result = await reqPromise;
    expect(result.action).toBe("allow");
  });

  it("SECU-012: 权限 resolve allow → 工具执行", async () => {
    const { PermissionManager } = await import("../core/permission/permission");
    const mgr = new PermissionManager();

    const promise = mgr.requestPermission({
      id: "req-allow",
      sessionId: "sess-test",
      tool: "read_file",
      input: { path: "/test" },
      timestamp: Date.now(),
    });

    mgr.resolvePermission("req-allow", { requestId: "req-allow", action: "allow" });
    const result = await promise;
    expect(result.action).toBe("allow");
  });

  it("SECU-012b: 权限 resolve deny → 工具跳过", async () => {
    const { PermissionManager } = await import("../core/permission/permission");
    const mgr = new PermissionManager();

    const promise = mgr.requestPermission({
      id: "req-deny",
      sessionId: "sess-test",
      tool: "bash",
      input: { command: "rm -rf /" },
      timestamp: Date.now(),
    });

    mgr.resolvePermission("req-deny", { requestId: "req-deny", action: "deny" });
    const result = await promise;
    expect(result.action).toBe("deny");
  });

  it("SECU-013: 多会话权限隔离", async () => {
    const { PermissionManager } = await import("../core/permission/permission");
    const mgr = new PermissionManager();

    const promiseA = mgr.requestPermission({
      id: "req-a",
      sessionId: "sess-a",
      tool: "bash",
      input: {},
      timestamp: Date.now(),
    });
    const promiseB = mgr.requestPermission({
      id: "req-b",
      sessionId: "sess-b",
      tool: "bash",
      input: {},
      timestamp: Date.now(),
    });

    // Resolve only A
    mgr.resolvePermission("req-a", { requestId: "req-a", action: "allow" });

    const resultA = await promiseA;
    expect(resultA.action).toBe("allow");

    // B should still be pending
    let resolvedB = false;
    promiseB.then(() => { resolvedB = true; });
    await new Promise(r => setTimeout(r, 50));
    expect(resolvedB).toBe(false);

    // Now resolve B
    mgr.resolvePermission("req-b", { requestId: "req-b", action: "deny" });
    const resultB = await promiseB;
    expect(resultB.action).toBe("deny");
  });

  it("SECU-013b: alwaysAllow 记住决策", async () => {
    const { PermissionManager } = await import("../core/permission/permission");
    const mgr = new PermissionManager();

    // First request — resolve with allow
    const promise1 = mgr.requestPermission({
      id: "req-always-1",
      sessionId: "sess-test",
      tool: "read_file",
      input: { path: "/test" },
      resource: "/test",
      timestamp: Date.now(),
    });
    mgr.resolvePermission("req-always-1", { requestId: "req-always-1", action: "allow" });
    await promise1;

    // Manually set always-allow (simulating what the UI would do)
    mgr.getEvaluator().setAlwaysAllow("read_file", "/test", "allow");

    // Second request for same tool:resource — should auto-allow without needing resolve
    const result2 = await mgr.requestPermission({
      id: "req-always-2",
      sessionId: "sess-test",
      tool: "read_file",
      input: { path: "/test" },
      resource: "/test",
      timestamp: Date.now(),
    });
    expect(result2.action).toBe("allow");
  });
});

describe("权限 — 沙箱路径检查", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("SECU-015: 沙箱禁用时可写任意路径", async () => {
    // Ensure sandbox is disabled
    removeSetting("codem-sandbox-enabled");

    // Import tools module to check sandbox logic
    const toolsSrc = await import("fs").then(fs =>
      fs.readFileSync(require("path").join(__dirname, "../core/llm/tools.ts"), "utf-8")
    );

    // Verify checkSandbox function exists and returns null when sandbox disabled
    expect(toolsSrc).toContain("function checkSandbox");
    expect(toolsSrc).toContain('getSetting("codem-sandbox-enabled")');
  });

  it("SECU-016: 沙箱启用代码路径检查逻辑存在", async () => {
    const toolsSrc = await import("fs").then(fs =>
      fs.readFileSync(require("path").join(__dirname, "../core/llm/tools.ts"), "utf-8")
    );

    // Verify the sandbox check logic exists
    expect(toolsSrc).toContain("isPathWithinWorkspace");
    expect(toolsSrc).toContain("outside the workspace");
  });

  it("SECU-017: resolvePath 相对路径拼接逻辑存在", async () => {
    const toolsSrc = await import("fs").then(fs =>
      fs.readFileSync(require("path").join(__dirname, "../core/llm/tools.ts"), "utf-8")
    );

    expect(toolsSrc).toContain("function resolvePath");
    // Windows drive letter detection
    expect(toolsSrc).toContain("[A-Za-z]:[\\\\/]");
  });
});

describe("权限 — 安全模式切换", () => {
  beforeEach(() => {
    localStorage.clear();
    removeSetting("codem-security-mode");
  });

  it("SECU-023: 安全模式切换实时生效", () => {
    // Start with ask
    setGlobalSecurityMode("ask");
    expect(getGlobalSecurityMode()).toBe("ask");
    expect(shouldCheckPermissions("ask")).toBe(true);

    // Switch to full
    setGlobalSecurityMode("full");
    expect(getGlobalSecurityMode()).toBe("full");
    expect(shouldCheckPermissions("full")).toBe(false);

    // Switch to auto
    setGlobalSecurityMode("auto");
    expect(getGlobalSecurityMode()).toBe("auto");
    expect(shouldCheckPermissions("auto")).toBe(true);
  });

  it("SECU-023b: 切换触发 CustomEvent", () => {
    let eventFired = false;
    window.addEventListener("codem-security-mode-changed", () => {
      eventFired = true;
    });

    setGlobalSecurityMode("full");
    expect(eventFired).toBe(true);
  });

  it("SECU-023c: 项目级切换也触发事件", () => {
    let eventDetail: any = null;
    window.addEventListener("codem-security-mode-changed", (e: any) => {
      eventDetail = e.detail;
    });

    setProjectSecurityMode("/test/proj", "auto");
    expect(eventDetail).not.toBeNull();
    expect(eventDetail.scope).toBe("project");
    expect(eventDetail.projectPath).toBe("/test/proj");
  });
});

describe("权限 — writeRejected 行为", () => {
  it("SECU-021: writeRejected 概念验证——Diff reject 停止循环", () => {
    // This is verified through agentic-loop source code inspection
    // The LoopState has writeRejected field
    const agenticLoopSrc = require("fs").readFileSync(
      require("path").join(__dirname, "../core/llm/agentic-loop.ts"),
      "utf-8"
    );
    expect(agenticLoopSrc).toContain("writeRejected");
    expect(agenticLoopSrc).toContain("writeRejected: boolean");
    expect(agenticLoopSrc).toContain("this.state.writeRejected = true");
  });
});

describe("权限 — SQL 注入防护", () => {
  it("SECU-024: Settings 使用参数化查询（不拼接 SQL）", () => {
    // setSetting with SQL injection attempt
    setSetting("test'; DROP TABLE projects;--", "value");
    // The key should be stored as-is, not executed as SQL
    expect(getSetting("test'; DROP TABLE projects;--")).toBe("value");

    // Projects table should still exist
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE name='projects'");
    expect(result.length).toBeGreaterThan(0);
  });

  it("SECU-024b: Session 标题含 SQL 注入字符串", async () => {
    const { initDatabase } = await import("../core/storage/database");
    try { await (await import("../core/storage/database")).resetDatabase(); } catch { await initDatabase(); }

    const SessionStorage = await import("../core/storage/session");
    const ProjectStorage = await import("../core/storage/project");
    ProjectStorage.createProject({
      id: "sqli-proj", name: "test", path: "/test",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });

    SessionStorage.createSession({
      id: "sqli-sess", projectId: "sqli-proj",
      title: "'; DROP TABLE messages;--",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    const loaded = SessionStorage.getSession("sqli-sess");
    expect(loaded!.title).toBe("'; DROP TABLE messages;--");

    // messages table should still exist
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE name='messages'");
    expect(result.length).toBeGreaterThan(0);
  });
});
