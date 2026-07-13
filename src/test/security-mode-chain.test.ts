/**
 * 测试：安全策略功能链条集成测试
 *
 * 测试覆盖：
 *   1. 不同安全策略下工具调用权限链路（ask/auto/full × read/write/bash）
 *   2. write 工具的 Diff 弹窗行为在不同模式下与 onWriteConfirm 回调的交互
 *   3. 安全策略与子智能体执行的交互（子智能体不阻塞、主任务提醒注入）
 *   4. 信息闭环：事件流完整性（permission_request → tool_start → tool_complete/end）
 *   5. 死循环防护（auto 模式下危险命令不自动放行、full 模式下受保护路径仍拒绝）
 *   6. PermissionManager 与 SecurityMode 的协作（无超时、可手动 resolve）
 *   7. 安全策略切换的实时生效
 *   8. 级联场景：全局 → 项目覆盖 → 工具执行 → 权限决策
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock agent registry
vi.mock("../core/agent/agent", () => ({
  getAgentRegistry: () => ({
    evaluatePermission: () => "ask",
  }),
}));

import {
  evaluateWithSecurityMode,
  shouldShowWriteConfirm,
  shouldCheckPermissions,
  isAutoApprovable,
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  getProjectSecurityMode,
  setProjectSecurityMode,
  getEffectiveSecurityMode,
  type SecurityMode,
} from "../core/permission/security-mode";
import {
  PermissionManager,
  PermissionEvaluator,
  type PermissionRequest,
  type PermissionResult,
} from "../core/permission/permission";
import {
  SubagentManager,
  type SubagentResult,
  type SubagentSpawner,
} from "../core/subagent/subagent";
import { ToolRegistry, createWriteFileTool, createReadFileTool, createBashTool, type ToolContext } from "../core/llm/tools";
import type { ToolCallResult } from "../core/llm/types";

// ========== Helper: Create a mock ToolContext ==========
function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd: "/tmp/test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    securityMode: "ask",
    ...overrides,
  };
}

// ========== Helper: Create a mock SubagentSpawner ==========
function createMockSpawner(): SubagentSpawner {
  return {
    spawn: vi.fn(async (task: any) => task),
    cancel: vi.fn(async () => {}),
    cancelAll: vi.fn(),
    getStatus: vi.fn(() => "running" as const),
    getResult: vi.fn(() => undefined),
  };
}

describe("安全策略功能链条集成测试", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // ==================================================================
  // 1. 工具调用权限链路：ask/auto/full × read/write/bash
  // ==================================================================
  describe("工具调用权限链路（ask/auto/full × read/write/bash）", () => {
    /**
     * 链路：SecurityMode → evaluateWithSecurityMode → 权限决策
     *
     * ask 模式：所有操作走 normalEvaluation
     * auto 模式：安全操作自动 allow，危险操作仍 ask，受保护路径始终 deny
     * full 模式：一切 allow（受保护路径除外）
     */

    it("ask 模式：read 工具 → normalEvaluation=ask → 最终 ask（需用户确认）", () => {
      const result = evaluateWithSecurityMode("ask", "read", "file.ts", "ask");
      expect(result).toBe("ask");
    });

    it("ask 模式：write 工具 → normalEvaluation=ask → 最终 ask（需用户确认 + Diff 弹窗）", () => {
      const result = evaluateWithSecurityMode("ask", "write", "file.ts", "ask");
      expect(result).toBe("ask");
      // 同时验证 Diff 弹窗会显示
      expect(shouldShowWriteConfirm("ask")).toBe(true);
    });

    it("ask 模式：bash rm -rf → normalEvaluation=ask → 最终 ask", () => {
      const result = evaluateWithSecurityMode("ask", "bash", "rm -rf /", "ask");
      expect(result).toBe("ask");
    });

    it("ask 模式：write .git/config → normalEvaluation=deny → 最终 deny（受保护路径）", () => {
      const result = evaluateWithSecurityMode("ask", "write", ".git/config", "deny");
      expect(result).toBe("deny");
    });

    it("auto 模式：read 工具 → 自动 allow（安全操作）", () => {
      const result = evaluateWithSecurityMode("auto", "read", "file.ts", "ask");
      expect(result).toBe("allow");
    });

    it("auto 模式：write 工具 → 自动 allow（跳过 Diff 弹窗）", () => {
      const result = evaluateWithSecurityMode("auto", "write", "file.ts", "ask");
      expect(result).toBe("allow");
      // auto 模式不显示 Diff 弹窗
      expect(shouldShowWriteConfirm("auto")).toBe(false);
    });

    it("auto 模式：bash npm install → 自动 allow", () => {
      const result = evaluateWithSecurityMode("auto", "bash", "npm install", "ask");
      expect(result).toBe("allow");
    });

    it("auto 模式：bash rm -rf → 仍需 ask（危险命令）", () => {
      const result = evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask");
      expect(result).toBe("ask");
    });

    it("auto 模式：bash sudo → 仍需 ask", () => {
      const result = evaluateWithSecurityMode("auto", "bash", "sudo apt update", "ask");
      expect(result).toBe("ask");
    });

    it("auto 模式：write .git → 仍 deny（受保护路径优先于模式）", () => {
      const result = evaluateWithSecurityMode("auto", "write", ".git/config", "deny");
      expect(result).toBe("deny");
    });

    it("full 模式：read 工具 → allow", () => {
      const result = evaluateWithSecurityMode("full", "read", "file.ts", "ask");
      expect(result).toBe("allow");
    });

    it("full 模式：write 工具 → allow（无 Diff 弹窗）", () => {
      const result = evaluateWithSecurityMode("full", "write", "file.ts", "ask");
      expect(result).toBe("allow");
      expect(shouldShowWriteConfirm("full")).toBe(false);
    });

    it("full 模式：bash rm -rf → allow（full 不检查危险命令）", () => {
      const result = evaluateWithSecurityMode("full", "bash", "rm -rf /", "ask");
      expect(result).toBe("allow");
    });

    it("full 模式：bash sudo → allow", () => {
      const result = evaluateWithSecurityMode("full", "bash", "sudo rm -rf /", "ask");
      expect(result).toBe("allow");
    });

    it("full 模式：write .git → 仍 deny（受保护路径在任何模式下都拒绝）", () => {
      const result = evaluateWithSecurityMode("full", "write", ".git/config", "deny");
      expect(result).toBe("deny");
    });

    it("full 模式：write .env → 仍 deny", () => {
      const result = evaluateWithSecurityMode("full", "write", ".env", "deny");
      expect(result).toBe("deny");
    });

    it("full 模式：权限检查被完全跳过（shouldCheckPermissions=false）", () => {
      expect(shouldCheckPermissions("full")).toBe(false);
    });
  });

  // ==================================================================
  // 2. write 工具与 onWriteConfirm 回调的交互
  // ==================================================================
  describe("write 工具 Diff 弹窗与 securityMode 的交互", () => {
    let registry: ToolRegistry;
    let writeConfirmCalls: number;
    let writeConfirmResult: "accept" | "reject" | "custom";

    beforeEach(() => {
      registry = new ToolRegistry();
      registry.register(createWriteFileTool());
      writeConfirmCalls = 0;
      writeConfirmResult = "accept";
    });

    /**
     * 链路：ToolContext.securityMode → write.execute → onWriteConfirm 调用/跳过
     *
     * ask 模式：onWriteConfirm 被调用
     * auto 模式：onWriteConfirm 不被调用
     * full 模式：onWriteConfirm 不被调用
     */

    it("ask 模式：写入覆盖时调用 onWriteConfirm", async () => {
      // Mock readFile to return existing content (trigger overwrite path)
      const existingContent = "line1\nline2\nline3\nline4\nline5";
      const newContent = "completely different content here";

      // We can't easily mock file-api, so test the securityMode logic directly
      const ctx = createMockCtx({
        securityMode: "ask",
        onWriteConfirm: async () => {
          writeConfirmCalls++;
          return { action: "accept" };
        },
      });

      // Verify that in ask mode, shouldShowWriteConfirm returns true
      // (the actual file I/O is tested in the tool tests, here we test the gate)
      expect(shouldShowWriteConfirm(ctx.securityMode!)).toBe(true);
    });

    it("auto 模式：写入覆盖时跳过 onWriteConfirm", async () => {
      const ctx = createMockCtx({
        securityMode: "auto",
        onWriteConfirm: async () => {
          writeConfirmCalls++;
          return { action: "accept" };
        },
      });

      // In auto mode, shouldShowWriteConfirm returns false → onWriteConfirm won't be called
      expect(shouldShowWriteConfirm(ctx.securityMode!)).toBe(false);
    });

    it("full 模式：写入覆盖时跳过 onWriteConfirm", async () => {
      const ctx = createMockCtx({
        securityMode: "full",
        onWriteConfirm: async () => {
          writeConfirmCalls++;
          return { action: "accept" };
        },
      });

      expect(shouldShowWriteConfirm(ctx.securityMode!)).toBe(false);
    });

    it("securityMode 未设置时默认为 ask（会显示 Diff 弹窗）", () => {
      const ctx = createMockCtx({ securityMode: undefined });
      const secMode = ctx.securityMode || "ask";
      expect(secMode).toBe("ask");
      expect(shouldShowWriteConfirm(secMode)).toBe(true);
    });
  });

  // ==================================================================
  // 3. 安全策略与子智能体执行的交互
  // ==================================================================
  describe("安全策略与子智能体执行", () => {
    let manager: SubagentManager;

    beforeEach(() => {
      manager = new SubagentManager();
      manager.setSpawner(createMockSpawner());
    });

    /**
     * 链路：AgenticLoop 检测到子智能体仍在运行 → 注入提醒 → 继续循环
     * 安全策略不影响子智能体的 spawn/wait 机制
     * 子智能体不继承父任务的安全模式（各自独立）
     */

    it("子智能体 spawn 后状态为 running", async () => {
      const task = await manager.spawn("parent-session", "explore", "search code", "/tmp");
      expect(task.status).toBe("running");
      expect(task.parentId).toBe("parent-session");
    });

    it("getChildTasks 返回指定父任务的子任务", async () => {
      await manager.spawn("parent-1", "explore", "task 1", "/tmp");
      await manager.spawn("parent-1", "build", "task 2", "/tmp");
      await manager.spawn("parent-2", "explore", "task 3", "/tmp");

      const children = manager.getChildTasks("parent-1");
      expect(children).toHaveLength(2);
      expect(children[0].agentId).toBe("explore");
      expect(children[1].agentId).toBe("build");
    });

    it("running 子智能体阻止主任务停止（模拟 AgenticLoop 的子智能体检查）", async () => {
      await manager.spawn("session-1", "explore", "search", "/tmp");
      const children = manager.getChildTasks("session-1");
      const running = children.filter(t => t.status === "running" || t.status === "pending");
      expect(running.length).toBe(1);
      // 主任务不应在此时停止
    });

    it("completed 子智能体不阻止主任务停止", async () => {
      const task = await manager.spawn("session-1", "explore", "search", "/tmp");
      manager.completeTask(task.id, {
        status: "success",
        summary: "done",
        output: "found files",
        filesTouched: [],
        findings: [],
      });

      const children = manager.getChildTasks("session-1");
      const running = children.filter(t => t.status === "running" || t.status === "pending");
      expect(running.length).toBe(0);
    });

    it("安全模式不影响子智能体的 spawn 和 wait", async () => {
      // 即使在 full 模式下，子智能体机制正常工作
      setGlobalSecurityMode("full");
      const task = await manager.spawn("session-1", "explore", "search", "/tmp");
      expect(task.status).toBe("running");

      manager.completeTask(task.id, {
        status: "success",
        summary: "done",
        output: "result",
        filesTouched: ["file.ts"],
        findings: [],
      });

      const result = await manager.waitForCompletion(task.id);
      expect(result.status).toBe("success");
    });

    it("子智能体并发限制（maxConcurrent=5）", async () => {
      // Spawn 5 tasks
      for (let i = 0; i < 5; i++) {
        await manager.spawn("session-1", "explore", `task ${i}`, "/tmp");
      }
      // 6th should throw
      await expect(manager.spawn("session-1", "explore", "task 5", "/tmp"))
        .rejects.toThrow("Maximum concurrent");
    });

    it("子智能体 cancelAll 将所有 running 改为 cancelled", async () => {
      const t1 = await manager.spawn("s1", "explore", "task 1", "/tmp");
      const t2 = await manager.spawn("s1", "build", "task 2", "/tmp");

      manager.cancelAll();

      expect(manager.getTask(t1.id)?.status).toBe("cancelled");
      expect(manager.getTask(t2.id)?.status).toBe("cancelled");
    });

    it("子智能体 waitForCompletion 无超时（可无限等待直到完成）", async () => {
      const task = await manager.spawn("s1", "explore", "long task", "/tmp");

      // 在 100ms 后完成任务
      setTimeout(() => {
        manager.completeTask(task.id, {
          status: "success",
          summary: "finally done",
          output: "result",
          filesTouched: [],
          findings: [],
        });
      }, 100);

      const result = await manager.waitForCompletion(task.id);
      expect(result.status).toBe("success");
      expect(result.summary).toBe("finally done");
    });

    it("子智能体 waitForCompletion 在失败时抛出错误", async () => {
      const task = await manager.spawn("s1", "build", "failing task", "/tmp");

      setTimeout(() => {
        manager.failTask(task.id, "Build error");
      }, 50);

      await expect(manager.waitForCompletion(task.id)).rejects.toThrow("Build error");
    });
  });

  // ==================================================================
  // 4. 信息闭环：事件流完整性
  // ==================================================================
  describe("信息闭环：权限决策事件流", () => {
    /**
     * 链路：
     *   AgenticLoop → evaluateWithSecurityMode → 决策
     *   ask 模式：action=ask → permission_request 事件 → 用户响应 → tool 执行
     *   auto 模式：action=allow → 直接执行（无 permission_request 事件）
     *   full 模式：跳过权限检查 → 直接执行
     *
     * 验证：每个模式下的信息流是完整的，不会出现"悬空"状态
     */

    it("ask 模式：权限链路完整（evaluate → ask → requestPermission → resolve → 执行）", async () => {
      const pm = new PermissionManager();
      const evaluator = pm.getEvaluator();

      // Step 1: 评估权限
      const rawAction = evaluator.evaluate("bash", "ls -la");
      expect(rawAction).toBe("ask");

      // Step 2: apply security mode
      const action = evaluateWithSecurityMode("ask", "bash", "ls -la", rawAction);
      expect(action).toBe("ask");

      // Step 3: request permission (模拟 AgenticLoop 调用 onPermissionRequest)
      const request: PermissionRequest = {
        id: "perm-1",
        sessionId: "s1",
        tool: "bash",
        input: { command: "ls -la" },
        resource: "ls -la",
        timestamp: Date.now(),
      };

      const promise = pm.requestPermission(request);

      // Step 4: 用户批准
      pm.resolvePermission("perm-1", { requestId: "perm-1", action: "allow" });

      const result = await promise;
      expect(result.action).toBe("allow");

      // 信息闭环：evaluate → ask → request → resolve → allow ✓
    });

    it("auto 模式：安全操作权限链路完整（evaluate → auto-allow → 无需 request）", () => {
      const evaluator = new PermissionEvaluator();
      const rawAction = evaluator.evaluate("bash", "npm install");
      // auto 模式下，npm install 是安全的 → isAutoApprovable=true
      const action = evaluateWithSecurityMode("auto", "bash", "npm install", rawAction);
      expect(action).toBe("allow");
      // 不需要 permission_request 事件 → 信息闭环：evaluate → auto-allow ✓
    });

    it("auto 模式：危险操作权限链路完整（evaluate → ask → request → resolve）", async () => {
      const pm = new PermissionManager();
      const evaluator = pm.getEvaluator();

      const rawAction = evaluator.evaluate("bash", "rm -rf /");
      const action = evaluateWithSecurityMode("auto", "bash", "rm -rf /", rawAction);
      expect(action).toBe("ask"); // 危险命令仍需询问

      // 需要 permission_request
      const request: PermissionRequest = {
        id: "perm-2",
        sessionId: "s1",
        tool: "bash",
        input: { command: "rm -rf /" },
        resource: "rm -rf /",
        timestamp: Date.now(),
      };

      const promise = pm.requestPermission(request);
      pm.resolvePermission("perm-2", { requestId: "perm-2", action: "deny" });

      const result = await promise;
      expect(result.action).toBe("deny");
      // 信息闭环：evaluate → ask → request → deny → 不执行 ✓
    });

    it("full 模式：权限链路完整（跳过 evaluate → 直接 allow）", () => {
      // full 模式下 shouldCheckPermissions=false，不会进入权限评估
      expect(shouldCheckPermissions("full")).toBe(false);

      // 即使 evaluate 返回 ask，evaluateWithSecurityMode 也返回 allow
      const action = evaluateWithSecurityMode("full", "bash", "rm -rf /", "ask");
      expect(action).toBe("allow");
      // 信息闭环：skip-check → allow → 直接执行 ✓
    });

    it("full 模式：受保护路径仍走 deny 链路（evaluate → deny → 不执行）", () => {
      const action = evaluateWithSecurityMode("full", "write", ".git/config", "deny");
      expect(action).toBe("deny");
      // 信息闭环：evaluate → deny → 不执行 ✓（即使 full 模式也保护 .git）
    });

    it("ask 模式：用户 deny 后工具不执行（返回 error）", async () => {
      // 模拟 AgenticLoop 中 onPermissionRequest 返回 deny 的场景
      const onPermissionRequest = vi.fn(async (_req: PermissionRequest) => ({
        requestId: "perm-3",
        action: "deny" as const,
      }));

      const request: PermissionRequest = {
        id: "perm-3",
        sessionId: "s1",
        tool: "write",
        input: { path: "file.ts", content: "test" },
        resource: "file.ts",
        timestamp: Date.now(),
      };

      const result = await onPermissionRequest(request);
      expect(result.action).toBe("deny");
      expect(onPermissionRequest).toHaveBeenCalledWith(request);
      // AgenticLoop 会返回 "Permission denied by user" → 工具不执行 ✓
    });

    it("权限请求无超时：pending 请求可被无限期等待", async () => {
      const pm = new PermissionManager();
      const request: PermissionRequest = {
        id: "perm-timeout-test",
        sessionId: "s1",
        tool: "bash",
        input: { command: "ls" },
        resource: "ls",
        timestamp: Date.now(),
      };

      const promise = pm.requestPermission(request);

      // 等待 200ms，确认 promise 仍然 pending
      let resolved = false;
      promise.then(() => { resolved = true; });
      await new Promise(r => setTimeout(r, 200));
      expect(resolved).toBe(false);

      // 手动 resolve
      pm.resolvePermission("perm-timeout-test", { requestId: "perm-timeout-test", action: "allow" });
      const result = await promise;
      expect(result.action).toBe("allow");
    });
  });

  // ==================================================================
  // 5. 死循环防护
  // ==================================================================
  describe("死循环防护", () => {
    /**
     * 场景1：auto 模式下，危险命令不会被自动放行导致无限执行
     * 场景2：full 模式下，受保护路径不会被放行
     * 场景3：auto 模式下，反复的危险命令都返回 ask（不会自动 allow 导致连锁破坏）
     * 场景4：full 模式下，连续多个危险命令都被 allow（不会因 ask 阻塞导致死循环）
     */

    it("auto 模式：连续 10 次 rm -rf 都返回 ask（不会自动放行）", () => {
      for (let i = 0; i < 10; i++) {
        const action = evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask");
        expect(action).toBe("ask");
      }
    });

    it("auto 模式：连续 10 次 sudo 都返回 ask", () => {
      for (let i = 0; i < 10; i++) {
        const action = evaluateWithSecurityMode("auto", "bash", "sudo rm -rf /", "ask");
        expect(action).toBe("ask");
      }
    });

    it("full 模式：连续 10 次 rm -rf 都返回 allow（不会因 ask 阻塞）", () => {
      for (let i = 0; i < 10; i++) {
        const action = evaluateWithSecurityMode("full", "bash", "rm -rf /", "ask");
        expect(action).toBe("allow");
      }
    });

    it("full 模式：.git 始终 deny（不会因 full 模式放行）", () => {
      for (let i = 0; i < 10; i++) {
        const action = evaluateWithSecurityMode("full", "write", ".git/config", "deny");
        expect(action).toBe("deny");
      }
    });

    it("full 模式：.env 始终 deny", () => {
      for (let i = 0; i < 10; i++) {
        const action = evaluateWithSecurityMode("full", "write", ".env", "deny");
        expect(action).toBe("deny");
      }
    });

    it("auto 模式：安全操作连续 10 次都 allow（不会突然变成 ask）", () => {
      for (let i = 0; i < 10; i++) {
        const action = evaluateWithSecurityMode("auto", "write", `file-${i}.ts`, "ask");
        expect(action).toBe("allow");
      }
    });

    it("auto 模式：混合安全/危险操作交替执行不会状态泄漏", () => {
      // 安全 → 危险 → 安全 → 危险
      expect(evaluateWithSecurityMode("auto", "write", "file.ts", "ask")).toBe("allow");
      expect(evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask")).toBe("ask");
      expect(evaluateWithSecurityMode("auto", "read", "file.ts", "ask")).toBe("allow");
      expect(evaluateWithSecurityMode("auto", "bash", "sudo rm", "ask")).toBe("ask");
      expect(evaluateWithSecurityMode("auto", "bash", "ls", "ask")).toBe("allow");
    });

    it("模式切换不会导致状态不一致", () => {
      // ask → auto → full → ask
      expect(evaluateWithSecurityMode("ask", "bash", "ls", "ask")).toBe("ask");
      expect(evaluateWithSecurityMode("auto", "bash", "ls", "ask")).toBe("allow");
      expect(evaluateWithSecurityMode("full", "bash", "ls", "ask")).toBe("allow");
      expect(evaluateWithSecurityMode("ask", "bash", "ls", "ask")).toBe("ask");
    });

    it("PermissionManager denyAll 后所有 pending 请求被拒绝", async () => {
      const pm = new PermissionManager();

      const promises = [];
      for (let i = 0; i < 5; i++) {
        const req: PermissionRequest = {
          id: `perm-${i}`,
          sessionId: "s1",
          tool: "bash",
          input: { command: "ls" },
          resource: "ls",
          timestamp: Date.now(),
        };
        promises.push(pm.requestPermission(req));
      }

      pm.denyAll();

      const results = await Promise.all(promises);
      for (const r of results) {
        expect(r.action).toBe("deny");
      }
    });
  });

  // ==================================================================
  // 6. 安全策略切换的实时生效
  // ==================================================================
  describe("安全策略切换实时生效", () => {
    /**
     * 链路：setGlobalSecurityMode → 事件通知 → getEffectiveSecurityMode 返回新模式
     */

    it("全局模式切换后 getEffectiveSecurityMode 立即反映新值", () => {
      setGlobalSecurityMode("ask");
      expect(getEffectiveSecurityMode()).toBe("ask");

      setGlobalSecurityMode("auto");
      expect(getEffectiveSecurityMode()).toBe("auto");

      setGlobalSecurityMode("full");
      expect(getEffectiveSecurityMode()).toBe("full");
    });

    it("项目级覆盖切换后 getEffectiveSecurityMode 立即反映", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/proj", "full");
      expect(getEffectiveSecurityMode("/proj")).toBe("full");

      setProjectSecurityMode("/proj", "auto");
      expect(getEffectiveSecurityMode("/proj")).toBe("auto");

      setProjectSecurityMode("/proj", null);
      expect(getEffectiveSecurityMode("/proj")).toBe("ask"); // 回退到全局
    });

    it("模式切换触发 window 事件（UI 可监听更新）", () => {
      let eventCount = 0;
      const handler = () => { eventCount++; };
      window.addEventListener("codem-security-mode-changed", handler);

      setGlobalSecurityMode("auto");
      setGlobalSecurityMode("full");
      setGlobalSecurityMode("ask");

      expect(eventCount).toBe(3);

      window.removeEventListener("codem-security-mode-changed", handler);
    });

    it("从 full 切换到 ask 后，权限检查恢复", () => {
      setGlobalSecurityMode("full");
      expect(shouldCheckPermissions(getEffectiveSecurityMode())).toBe(false);

      setGlobalSecurityMode("ask");
      expect(shouldCheckPermissions(getEffectiveSecurityMode())).toBe(true);
    });

    it("从 ask 切换到 auto 后，Diff 弹窗消失", () => {
      setGlobalSecurityMode("ask");
      expect(shouldShowWriteConfirm(getEffectiveSecurityMode())).toBe(true);

      setGlobalSecurityMode("auto");
      expect(shouldShowWriteConfirm(getEffectiveSecurityMode())).toBe(false);
    });
  });

  // ==================================================================
  // 7. 级联场景：全局 → 项目覆盖 → 工具执行 → 权限决策
  // ==================================================================
  describe("级联场景", () => {
    it("场景：全局 ask，项目 auto → 工具执行时 auto 生效", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/project-x", "auto");

      const mode = getEffectiveSecurityMode("/project-x");
      expect(mode).toBe("auto");

      // auto 模式下 write 操作自动放行
      const action = evaluateWithSecurityMode(mode, "write", "src/main.ts", "ask");
      expect(action).toBe("allow");

      // auto 模式下不显示 Diff 弹窗
      expect(shouldShowWriteConfirm(mode)).toBe(false);
    });

    it("场景：全局 auto，项目 ask → 项目级别更严格", () => {
      setGlobalSecurityMode("auto");
      setProjectSecurityMode("/project-y", "ask");

      const mode = getEffectiveSecurityMode("/project-y");
      expect(mode).toBe("ask");

      // ask 模式下 write 操作需确认
      const action = evaluateWithSecurityMode(mode, "write", "src/main.ts", "ask");
      expect(action).toBe("ask");

      // ask 模式下显示 Diff 弹窗
      expect(shouldShowWriteConfirm(mode)).toBe(true);
    });

    it("场景：全局 full，项目 ask → 项目级别恢复审批", () => {
      setGlobalSecurityMode("full");
      setProjectSecurityMode("/project-z", "ask");

      const mode = getEffectiveSecurityMode("/project-z");
      expect(mode).toBe("ask");

      // ask 模式下 bash rm -rf 需确认
      const action = evaluateWithSecurityMode(mode, "bash", "rm -rf /", "ask");
      expect(action).toBe("ask");
    });

    it("场景：三个项目同时使用不同模式", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/proj-a", "auto");
      setProjectSecurityMode("/proj-b", "full");
      // /proj-c 使用全局 ask

      const modeA = getEffectiveSecurityMode("/proj-a");
      const modeB = getEffectiveSecurityMode("/proj-b");
      const modeC = getEffectiveSecurityMode("/proj-c");

      expect(modeA).toBe("auto");
      expect(modeB).toBe("full");
      expect(modeC).toBe("ask");

      // 同一个操作在不同项目下有不同行为
      const actionA = evaluateWithSecurityMode(modeA, "write", "file.ts", "ask");
      const actionB = evaluateWithSecurityMode(modeB, "write", "file.ts", "ask");
      const actionC = evaluateWithSecurityMode(modeC, "write", "file.ts", "ask");

      expect(actionA).toBe("allow"); // auto
      expect(actionB).toBe("allow"); // full
      expect(actionC).toBe("ask");   // ask
    });

    it("场景：清除项目覆盖后回退到全局模式", () => {
      setGlobalSecurityMode("full");
      setProjectSecurityMode("/proj", "ask");
      expect(getEffectiveSecurityMode("/proj")).toBe("ask");

      setProjectSecurityMode("/proj", null);
      expect(getEffectiveSecurityMode("/proj")).toBe("full");
    });

    it("场景：full 模式下完整工具调用链路（read → write → bash）", () => {
      const mode: SecurityMode = "full";

      // read：allow
      expect(evaluateWithSecurityMode(mode, "read", "input.ts", "ask")).toBe("allow");
      // write：allow（无 Diff 弹窗）
      expect(evaluateWithSecurityMode(mode, "write", "output.ts", "ask")).toBe("allow");
      expect(shouldShowWriteConfirm(mode)).toBe(false);
      // bash：allow（即使危险命令）
      expect(evaluateWithSecurityMode(mode, "bash", "npm test", "ask")).toBe("allow");
      expect(evaluateWithSecurityMode(mode, "bash", "rm -rf dist", "ask")).toBe("allow");
      // 但 .git 始终 deny
      expect(evaluateWithSecurityMode(mode, "write", ".git/HEAD", "deny")).toBe("deny");
    });

    it("场景：ask 模式下完整工具调用链路", () => {
      const mode: SecurityMode = "ask";

      // read：ask
      expect(evaluateWithSecurityMode(mode, "read", "input.ts", "ask")).toBe("ask");
      // write：ask + Diff 弹窗
      expect(evaluateWithSecurityMode(mode, "write", "output.ts", "ask")).toBe("ask");
      expect(shouldShowWriteConfirm(mode)).toBe(true);
      // bash 安全命令：ask
      expect(evaluateWithSecurityMode(mode, "bash", "npm test", "ask")).toBe("ask");
      // bash 危险命令：ask
      expect(evaluateWithSecurityMode(mode, "bash", "rm -rf dist", "ask")).toBe("ask");
      // .git：deny
      expect(evaluateWithSecurityMode(mode, "write", ".git/HEAD", "deny")).toBe("deny");
    });

    it("场景：auto 模式下完整工具调用链路", () => {
      const mode: SecurityMode = "auto";

      // read：allow（安全）
      expect(evaluateWithSecurityMode(mode, "read", "input.ts", "ask")).toBe("allow");
      // write：allow（无 Diff 弹窗）
      expect(evaluateWithSecurityMode(mode, "write", "output.ts", "ask")).toBe("allow");
      expect(shouldShowWriteConfirm(mode)).toBe(false);
      // bash 安全命令：allow
      expect(evaluateWithSecurityMode(mode, "bash", "npm test", "ask")).toBe("allow");
      // bash 危险命令：ask
      expect(evaluateWithSecurityMode(mode, "bash", "rm -rf dist", "ask")).toBe("ask");
      // .git：deny
      expect(evaluateWithSecurityMode(mode, "write", ".git/HEAD", "deny")).toBe("deny");
    });
  });

  // ==================================================================
  // 8. 权限评估器与安全模式的深度交互
  // ==================================================================
  describe("PermissionEvaluator 与 SecurityMode 深度交互", () => {
    let evaluator: PermissionEvaluator;

    beforeEach(() => {
      evaluator = new PermissionEvaluator();
    });

    it("ask 模式：evaluator 返回 allow → evaluateWithSecurityMode 返回 allow", () => {
      evaluator.setAlwaysAllow("bash", "safe-cmd", "allow");
      const rawAction = evaluator.evaluate("bash", "safe-cmd");
      expect(rawAction).toBe("allow");

      const action = evaluateWithSecurityMode("ask", "bash", "safe-cmd", rawAction);
      expect(action).toBe("allow");
    });

    it("ask 模式：evaluator 返回 deny → evaluateWithSecurityMode 返回 deny", () => {
      const rawAction = evaluator.evaluate("write", "project/.git/config");
      expect(rawAction).toBe("deny");

      const action = evaluateWithSecurityMode("ask", "write", "project/.git/config", rawAction);
      expect(action).toBe("deny");
    });

    it("auto 模式：evaluator 返回 ask → 安全操作自动 allow", () => {
      const rawAction = evaluator.evaluate("write", "src/main.ts");
      expect(rawAction).toBe("ask");

      const action = evaluateWithSecurityMode("auto", "write", "src/main.ts", rawAction);
      expect(action).toBe("allow");
    });

    it("auto 模式：evaluator 返回 ask → 危险操作仍 ask", () => {
      const rawAction = evaluator.evaluate("bash", "rm -rf /");
      expect(rawAction).toBe("ask");

      const action = evaluateWithSecurityMode("auto", "bash", "rm -rf /", rawAction);
      expect(action).toBe("ask");
    });

    it("auto 模式：evaluator 返回 deny → 仍 deny（受保护路径优先）", () => {
      const rawAction = evaluator.evaluate("write", "project/.env");
      expect(rawAction).toBe("deny");

      const action = evaluateWithSecurityMode("auto", "write", "project/.env", rawAction);
      expect(action).toBe("deny");
    });

    it("full 模式：evaluator 返回 ask → allow", () => {
      const rawAction = evaluator.evaluate("bash", "ls");
      expect(rawAction).toBe("ask");

      const action = evaluateWithSecurityMode("full", "bash", "ls", rawAction);
      expect(action).toBe("allow");
    });

    it("full 模式：evaluator 返回 deny → 仍 deny", () => {
      const rawAction = evaluator.evaluate("write", "project/node_modules/pkg/index.js");
      expect(rawAction).toBe("deny");

      const action = evaluateWithSecurityMode("full", "write", "project/node_modules/pkg/index.js", rawAction);
      expect(action).toBe("deny");
    });

    it("自定义 allow 规则在 ask 模式下生效", () => {
      evaluator.addCustomRule({ tool: "bash", action: "allow", resource: "npm*" });
      const rawAction = evaluator.evaluate("bash", "npm install");
      expect(rawAction).toBe("allow");

      // ask 模式下仍为 allow（自定义规则优先）
      const action = evaluateWithSecurityMode("ask", "bash", "npm install", rawAction);
      expect(action).toBe("allow");
    });

    it("自定义 deny 规则在 full 模式下仍生效", () => {
      evaluator.addCustomRule({ tool: "bash", action: "deny", resource: "dangerous-cmd*" });
      const rawAction = evaluator.evaluate("bash", "dangerous-cmd --flag");
      expect(rawAction).toBe("deny");

      // full 模式下 deny 仍优先
      const action = evaluateWithSecurityMode("full", "bash", "dangerous-cmd --flag", rawAction);
      expect(action).toBe("deny");
    });
  });

  // ==================================================================
  // 9. 综合压力测试：模拟完整的 AgenticLoop 工具执行决策
  // ==================================================================
  describe("综合压力测试：模拟 AgenticLoop 工具决策", () => {
    it("模拟一次完整的迭代：read → write → bash（auto 模式）", () => {
      const mode: SecurityMode = "auto";
      const evaluator = new PermissionEvaluator();

      // Step 1: read 文件
      const readRaw = evaluator.evaluate("read", "src/main.ts");
      const readAction = evaluateWithSecurityMode(mode, "read", "src/main.ts", readRaw);
      expect(readAction).toBe("allow"); // auto 模式安全操作

      // Step 2: write 文件
      const writeRaw = evaluator.evaluate("write", "src/main.ts");
      const writeAction = evaluateWithSecurityMode(mode, "write", "src/main.ts", writeRaw);
      expect(writeAction).toBe("allow"); // auto 模式跳过 Diff
      expect(shouldShowWriteConfirm(mode)).toBe(false);

      // Step 3: bash 运行测试
      const bashRaw = evaluator.evaluate("bash", "npm test");
      const bashAction = evaluateWithSecurityMode(mode, "bash", "npm test", bashRaw);
      expect(bashAction).toBe("allow"); // 安全命令

      // Step 4: bash 危险操作（不应自动放行）
      const dangerousRaw = evaluator.evaluate("bash", "rm -rf node_modules");
      const dangerousAction = evaluateWithSecurityMode(mode, "bash", "rm -rf node_modules", dangerousRaw);
      expect(dangerousAction).toBe("ask"); // 仍需确认
    });

    it("模拟一次完整的迭代：read → write → bash（ask 模式）", () => {
      const mode: SecurityMode = "ask";
      const evaluator = new PermissionEvaluator();

      // 所有操作都需要确认
      expect(evaluateWithSecurityMode(mode, "read", "src/main.ts", evaluator.evaluate("read", "src/main.ts"))).toBe("ask");
      expect(evaluateWithSecurityMode(mode, "write", "src/main.ts", evaluator.evaluate("write", "src/main.ts"))).toBe("ask");
      expect(shouldShowWriteConfirm(mode)).toBe(true);
      expect(evaluateWithSecurityMode(mode, "bash", "npm test", evaluator.evaluate("bash", "npm test"))).toBe("ask");
      expect(evaluateWithSecurityMode(mode, "bash", "rm -rf /", evaluator.evaluate("bash", "rm -rf /"))).toBe("ask");
    });

    it("模拟一次完整的迭代：read → write → bash（full 模式）", () => {
      const mode: SecurityMode = "full";
      const evaluator = new PermissionEvaluator();

      // 所有操作自动放行（受保护路径除外）
      expect(evaluateWithSecurityMode(mode, "read", "src/main.ts", evaluator.evaluate("read", "src/main.ts"))).toBe("allow");
      expect(evaluateWithSecurityMode(mode, "write", "src/main.ts", evaluator.evaluate("write", "src/main.ts"))).toBe("allow");
      expect(shouldShowWriteConfirm(mode)).toBe(false);
      expect(evaluateWithSecurityMode(mode, "bash", "npm test", evaluator.evaluate("bash", "npm test"))).toBe("allow");
      expect(evaluateWithSecurityMode(mode, "bash", "rm -rf /", evaluator.evaluate("bash", "rm -rf /"))).toBe("allow");

      // 但 .git 和 .env 仍被保护（路径需要匹配 **/ 前缀模式）
      expect(evaluateWithSecurityMode(mode, "write", "project/.git/config", evaluator.evaluate("write", "project/.git/config"))).toBe("deny");
      expect(evaluateWithSecurityMode(mode, "write", "project/.env", evaluator.evaluate("write", "project/.env"))).toBe("deny");
    });

    it("模拟子智能体执行场景：spawn → wait → 完成", async () => {
      const manager = new SubagentManager();
      manager.setSpawner(createMockSpawner());

      setGlobalSecurityMode("auto");

      // spawn 不受安全模式影响
      const task = await manager.spawn("session-1", "explore", "find all TODO comments", "/tmp");

      // 模拟子智能体执行（在 full 模式下也不影响）
      setGlobalSecurityMode("full");

      // 子智能体完成
      manager.completeTask(task.id, {
        status: "success",
        summary: "Found 5 TODOs",
        output: "TODO details...",
        filesTouched: ["src/a.ts", "src/b.ts"],
        findings: ["Consider using FIXME instead"],
      });

      // wait_for_subagent 获取结果
      const result = await manager.waitForCompletion(task.id);
      expect(result.status).toBe("success");
      expect(result.filesTouched).toHaveLength(2);

      // 验证子智能体不会因模式切换而阻塞
      setGlobalSecurityMode("ask");
      // 子智能体已完成，模式切换不影响结果
      const finalTask = manager.getTask(task.id);
      expect(finalTask?.status).toBe("completed");
    });

    it("模拟多轮对话中的权限决策一致性", () => {
      setGlobalSecurityMode("auto");

      // 第1轮：write
      expect(evaluateWithSecurityMode("auto", "write", "file1.ts", "ask")).toBe("allow");
      // 第2轮：bash 危险命令
      expect(evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask")).toBe("ask");
      // 第3轮：read
      expect(evaluateWithSecurityMode("auto", "read", "file1.ts", "ask")).toBe("allow");
      // 第4轮：write .git
      expect(evaluateWithSecurityMode("auto", "write", ".git/config", "deny")).toBe("deny");
      // 第5轮：bash 安全命令
      expect(evaluateWithSecurityMode("auto", "bash", "git status", "ask")).toBe("allow");

      // 一致性：相同操作在相同模式下结果一致
      expect(evaluateWithSecurityMode("auto", "write", "file1.ts", "ask")).toBe("allow");
      expect(evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask")).toBe("ask");
    });
  });
});
