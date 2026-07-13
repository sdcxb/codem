/**
 * 测试：三级安全策略（SecurityMode）
 *
 * 改动影响：
 *   - security-mode.ts: 新增 SecurityMode 类型、全局/项目级模式存储、优先级解析、
 *     行为判断函数（shouldShowWriteConfirm、shouldCheckPermissions、isAutoApprovable、evaluateWithSecurityMode）
 *   - permission.ts: 移除 5 分钟超时
 *   - tools.ts: write 工具根据 securityMode 跳过 Diff 审查
 *   - agentic-loop.ts: 权限检查根据 securityMode 调整
 *
 * 测试范围：
 *   1. 全局模式存储（get/set、默认值、无效值回退）
 *   2. 项目级模式存储（get/set/null 清除、持久化）
 *   3. 优先级解析（project > global > default）
 *   4. 行为判断：shouldShowWriteConfirm
 *   5. 行为判断：shouldCheckPermissions
 *   6. 行为判断：isAutoApprovable（危险命令识别）
 *   7. 行为判断：evaluateWithSecurityMode（三级模式 × 三种基础评估的组合）
 *   8. SECURITY_MODES 常量完整性
 *   9. PermissionManager 无超时验证
 *  10. write 工具在不同模式下的 Diff 弹窗行为
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
import { getSetting, setSetting, removeSetting } from "../core/storage/settings";
import { PermissionManager } from "../core/permission/permission";

describe("三级安全策略（SecurityMode）", () => {
  beforeEach(() => {
    localStorage.clear();
    // Clear all security mode settings
    removeSetting("codem-security-mode");
  });

  // ===== 1. 全局模式存储 =====
  describe("全局模式存储", () => {
    it("未设置时默认返回 'ask'", () => {
      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("设置 'ask' 后能正确读取", () => {
      setGlobalSecurityMode("ask");
      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("设置 'auto' 后能正确读取", () => {
      setGlobalSecurityMode("auto");
      expect(getGlobalSecurityMode()).toBe("auto");
    });

    it("设置 'full' 后能正确读取", () => {
      setGlobalSecurityMode("full");
      expect(getGlobalSecurityMode()).toBe("full");
    });

    it("存储值是字符串类型（通过 getSetting 验证）", () => {
      setGlobalSecurityMode("full");
      expect(getSetting("codem-security-mode")).toBe("full");
    });

    it("无效值（如 'yolo'）回退到 'ask'", () => {
      setSetting("codem-security-mode", "yolo");
      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("空字符串回退到 'ask'", () => {
      setSetting("codem-security-mode", "");
      expect(getGlobalSecurityMode()).toBe("ask");
    });

    it("设置模式后触发 window 事件", () => {
      let eventDetail: any = null;
      window.addEventListener("codem-security-mode-changed", ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      setGlobalSecurityMode("auto");
      expect(eventDetail).not.toBeNull();
      expect(eventDetail.mode).toBe("auto");
      expect(eventDetail.scope).toBe("global");

      window.removeEventListener("codem-security-mode-changed", ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);
    });
  });

  // ===== 2. 项目级模式存储 =====
  describe("项目级模式存储", () => {
    it("未设置时返回 null（使用全局模式）", () => {
      expect(getProjectSecurityMode("/project/a")).toBeNull();
    });

    it("设置项目模式后能正确读取", () => {
      setProjectSecurityMode("/project/a", "auto");
      expect(getProjectSecurityMode("/project/a")).toBe("auto");
    });

    it("不同项目路径互不干扰", () => {
      setProjectSecurityMode("/project/a", "auto");
      setProjectSecurityMode("/project/b", "full");
      expect(getProjectSecurityMode("/project/a")).toBe("auto");
      expect(getProjectSecurityMode("/project/b")).toBe("full");
    });

    it("设置为 null 后清除项目覆盖", () => {
      setProjectSecurityMode("/project/a", "full");
      expect(getProjectSecurityMode("/project/a")).toBe("full");

      setProjectSecurityMode("/project/a", null);
      expect(getProjectSecurityMode("/project/a")).toBeNull();
    });

    it("项目模式存储在独立的 key 中", () => {
      setProjectSecurityMode("/project/a", "auto");
      expect(getSetting("codem-security-mode-project:/project/a")).toBe("auto");
    });

    it("无效值回退到 null", () => {
      setSetting("codem-security-mode-project:/project/a", "invalid");
      expect(getProjectSecurityMode("/project/a")).toBeNull();
    });

    it("设置项目模式后触发 window 事件", () => {
      let eventDetail: any = null;
      window.addEventListener("codem-security-mode-changed", ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      setProjectSecurityMode("/project/a", "full");
      expect(eventDetail).not.toBeNull();
      expect(eventDetail.mode).toBe("full");
      expect(eventDetail.scope).toBe("project");
      expect(eventDetail.projectPath).toBe("/project/a");

      window.removeEventListener("codem-security-mode-changed", ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);
    });
  });

  // ===== 3. 优先级解析 =====
  describe("优先级解析 getEffectiveSecurityMode", () => {
    it("无项目路径时使用全局模式", () => {
      setGlobalSecurityMode("auto");
      expect(getEffectiveSecurityMode()).toBe("auto");
    });

    it("无项目路径时默认为 'ask'", () => {
      expect(getEffectiveSecurityMode()).toBe("ask");
    });

    it("有项目路径但无项目覆盖时使用全局模式", () => {
      setGlobalSecurityMode("full");
      expect(getEffectiveSecurityMode("/project/a")).toBe("full");
    });

    it("项目覆盖优先于全局模式", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/project/a", "full");
      expect(getEffectiveSecurityMode("/project/a")).toBe("full");
    });

    it("不同项目可以有不同模式", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/project/a", "auto");
      setProjectSecurityMode("/project/b", "full");
      expect(getEffectiveSecurityMode("/project/a")).toBe("auto");
      expect(getEffectiveSecurityMode("/project/b")).toBe("full");
      expect(getEffectiveSecurityMode("/project/c")).toBe("ask"); // 无覆盖 → 全局
    });

    it("清除项目覆盖后回退到全局", () => {
      setGlobalSecurityMode("auto");
      setProjectSecurityMode("/project/a", "full");
      expect(getEffectiveSecurityMode("/project/a")).toBe("full");

      setProjectSecurityMode("/project/a", null);
      expect(getEffectiveSecurityMode("/project/a")).toBe("auto"); // 回退到全局
    });
  });

  // ===== 4. shouldShowWriteConfirm =====
  describe("shouldShowWriteConfirm", () => {
    it("'ask' 模式显示 Diff 审查弹窗", () => {
      expect(shouldShowWriteConfirm("ask")).toBe(true);
    });

    it("'auto' 模式跳过 Diff 审查弹窗", () => {
      expect(shouldShowWriteConfirm("auto")).toBe(false);
    });

    it("'full' 模式跳过 Diff 审查弹窗", () => {
      expect(shouldShowWriteConfirm("full")).toBe(false);
    });
  });

  // ===== 5. shouldCheckPermissions =====
  describe("shouldCheckPermissions", () => {
    it("'ask' 模式执行权限检查", () => {
      expect(shouldCheckPermissions("ask")).toBe(true);
    });

    it("'auto' 模式执行权限检查（但只对危险操作询问）", () => {
      expect(shouldCheckPermissions("auto")).toBe(true);
    });

    it("'full' 模式跳过所有权限检查", () => {
      expect(shouldCheckPermissions("full")).toBe(false);
    });
  });

  // ===== 6. isAutoApprovable =====
  describe("isAutoApprovable — 危险命令识别", () => {
    it("read 工具始终可自动批准", () => {
      expect(isAutoApprovable("read", "/path/to/file")).toBe(true);
    });

    it("write 工具可自动批准（Diff 弹窗由 shouldShowWriteConfirm 控制）", () => {
      expect(isAutoApprovable("write", "/path/to/file")).toBe(true);
    });

    it("bash ls 可自动批准", () => {
      expect(isAutoApprovable("bash", "ls -la")).toBe(true);
    });

    it("bash npm install 可自动批准", () => {
      expect(isAutoApprovable("bash", "npm install")).toBe(true);
    });

    it("bash rm -rf 不可自动批准", () => {
      expect(isAutoApprovable("bash", "rm -rf /")).toBe(false);
    });

    it("bash rm -rf 带路径不可自动批准", () => {
      expect(isAutoApprovable("bash", "rm -rf node_modules")).toBe(false);
    });

    it("bash sudo 不可自动批准", () => {
      expect(isAutoApprovable("bash", "sudo apt-get update")).toBe(false);
    });

    it("bash git push --force 不可自动批准", () => {
      expect(isAutoApprovable("bash", "git push --force origin main")).toBe(false);
    });

    it("bash git reset --hard 不可自动批准", () => {
      expect(isAutoApprovable("bash", "git reset --hard HEAD~3")).toBe(false);
    });

    it("bash chmod 不可自动批准", () => {
      expect(isAutoApprovable("bash", "chmod 755 script.sh")).toBe(false);
    });

    it("bash chown 不可自动批准", () => {
      expect(isAutoApprovable("bash", "chown root:root file")).toBe(false);
    });

    it("bash mkfs 不可自动批准", () => {
      expect(isAutoApprovable("bash", "mkfs.ext4 /dev/sda1")).toBe(false);
    });

    it("bash dd 不可自动批准", () => {
      expect(isAutoApprovable("bash", "dd if=/dev/zero of=/dev/sda")).toBe(false);
    });

    it("bash shutdown 不可自动批准", () => {
      expect(isAutoApprovable("bash", "shutdown now")).toBe(false);
    });

    it("bash reboot 不可自动批准", () => {
      expect(isAutoApprovable("bash", "reboot")).toBe(false);
    });

    it("bash fork bomb 不可自动批准", () => {
      expect(isAutoApprovable("bash", ":() { :|:& }; :")).toBe(false);
    });

    it("未知工具可自动批准", () => {
      expect(isAutoApprovable("unknown_tool", "resource")).toBe(true);
    });

    it("bash 无 resource 参数可自动批准", () => {
      expect(isAutoApprovable("bash", undefined)).toBe(true);
    });
  });

  // ===== 7. evaluateWithSecurityMode =====
  describe("evaluateWithSecurityMode — 三级模式 × 三种基础评估", () => {
    // --- "ask" 模式 ---
    describe("'ask' 模式", () => {
      it("基础评估 allow → allow", () => {
        expect(evaluateWithSecurityMode("ask", "read", "file.txt", "allow")).toBe("allow");
      });

      it("基础评估 deny → deny", () => {
        expect(evaluateWithSecurityMode("ask", "write", ".git/config", "deny")).toBe("deny");
      });

      it("基础评估 ask → ask", () => {
        expect(evaluateWithSecurityMode("ask", "write", "file.txt", "ask")).toBe("ask");
      });
    });

    // --- "auto" 模式 ---
    describe("'auto' 模式", () => {
      it("安全操作（write）→ allow（跳过 Diff 弹窗）", () => {
        expect(evaluateWithSecurityMode("auto", "write", "src/main.ts", "ask")).toBe("allow");
      });

      it("安全操作（read）→ allow", () => {
        expect(evaluateWithSecurityMode("auto", "read", "src/main.ts", "ask")).toBe("allow");
      });

      it("安全操作（bash ls）→ allow", () => {
        expect(evaluateWithSecurityMode("auto", "bash", "ls -la", "ask")).toBe("allow");
      });

      it("危险操作（rm -rf）→ ask", () => {
        expect(evaluateWithSecurityMode("auto", "bash", "rm -rf /", "ask")).toBe("ask");
      });

      it("危险操作（sudo）→ ask", () => {
        expect(evaluateWithSecurityMode("auto", "bash", "sudo apt update", "ask")).toBe("ask");
      });

      it("受保护路径（.git）→ deny（即使 auto 模式也拒绝）", () => {
        expect(evaluateWithSecurityMode("auto", "write", ".git/config", "deny")).toBe("deny");
      });

      it("受保护路径（.env）→ deny", () => {
        expect(evaluateWithSecurityMode("auto", "write", ".env", "deny")).toBe("deny");
      });

      it("基础评估 allow + auto → allow", () => {
        expect(evaluateWithSecurityMode("auto", "read", "file.txt", "allow")).toBe("allow");
      });
    });

    // --- "full" 模式 ---
    describe("'full' 模式", () => {
      it("普通操作 → allow（跳过所有检查）", () => {
        expect(evaluateWithSecurityMode("full", "write", "src/main.ts", "ask")).toBe("allow");
      });

      it("危险操作 → allow（full 模式不检查危险命令）", () => {
        expect(evaluateWithSecurityMode("full", "bash", "rm -rf /", "ask")).toBe("allow");
      });

      it("sudo → allow（full 模式不检查危险命令）", () => {
        expect(evaluateWithSecurityMode("full", "bash", "sudo rm -rf /", "ask")).toBe("allow");
      });

      it("受保护路径（.git）→ deny（即使 full 模式也拒绝）", () => {
        expect(evaluateWithSecurityMode("full", "write", ".git/config", "deny")).toBe("deny");
      });

      it("受保护路径（.env）→ deny", () => {
        expect(evaluateWithSecurityMode("full", "write", ".env", "deny")).toBe("deny");
      });

      it("受保护路径（node_modules）→ deny", () => {
        expect(evaluateWithSecurityMode("full", "write", "node_modules/pkg/index.js", "deny")).toBe("deny");
      });

      it("基础评估 allow + full → allow", () => {
        expect(evaluateWithSecurityMode("full", "read", "file.txt", "allow")).toBe("allow");
      });
    });
  });

  // ===== 8. SECURITY_MODES 常量完整性 =====
  describe("SECURITY_MODES 常量", () => {
    it("包含三个模式", () => {
      expect(SECURITY_MODES).toHaveLength(3);
    });

    it("包含 ask、auto、full 三种模式", () => {
      const modes = SECURITY_MODES.map(m => m.mode);
      expect(modes).toContain("ask");
      expect(modes).toContain("auto");
      expect(modes).toContain("full");
    });

    it("每个模式都有完整的 label 和 desc（中英文）", () => {
      for (const m of SECURITY_MODES) {
        expect(m.label_zh).toBeTruthy();
        expect(m.label_en).toBeTruthy();
        expect(m.desc_zh).toBeTruthy();
        expect(m.desc_en).toBeTruthy();
        expect(m.icon).toBeTruthy();
      }
    });

    it("每个模式有唯一的 icon", () => {
      const icons = SECURITY_MODES.map(m => m.icon);
      expect(new Set(icons).size).toBe(3);
    });
  });

  // ===== 9. PermissionManager 无超时验证 =====
  describe("PermissionManager 无超时", () => {
    it("requestPermission 不设置 setTimeout 超时", () => {
      const manager = new PermissionManager();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      // 强制进入 pending 分支：需要让 evaluate 返回 "ask"
      // 默认 evaluate("unknown_tool") 返回 "ask"
      const promise = manager.requestPermission({
        id: "test-1",
        sessionId: "session-1",
        tool: "unknown_tool",
        input: {},
        resource: "test-resource",
        timestamp: Date.now(),
      });

      // setTimeout 不应被调用（之前的 5 分钟超时已移除）
      // 注意：setTimeout 可能被其他代码调用，所以检查调用参数中没有 5*60*1000
      const timeoutCalls = setTimeoutSpy.mock.calls.filter(
        ([, delay]) => delay === 5 * 60 * 1000
      );
      expect(timeoutCalls).toHaveLength(0);

      // 清理：拒绝 pending request
      manager.resolvePermission("test-1", { requestId: "test-1", action: "deny" });
      setTimeoutSpy.mockRestore();
    });

    it("pending request 可被无限期等待（不超时拒绝）", async () => {
      const manager = new PermissionManager();

      const promise = manager.requestPermission({
        id: "test-2",
        sessionId: "session-1",
        tool: "unknown_tool",
        input: {},
        resource: "test",
        timestamp: Date.now(),
      });

      // 等待一小段时间
      await new Promise(resolve => setTimeout(resolve, 100));

      // promise 仍然 pending（未 resolve）
      let resolved = false;
      promise.then(() => { resolved = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(resolved).toBe(false);

      // 手动 resolve
      manager.resolvePermission("test-2", { requestId: "test-2", action: "allow" });
      const result = await promise;
      expect(result.action).toBe("allow");
    });

    it("denyAll 清除所有 pending requests", async () => {
      const manager = new PermissionManager();

      const promise1 = manager.requestPermission({
        id: "test-3",
        sessionId: "s1",
        tool: "unknown_tool",
        input: {},
        resource: "r1",
        timestamp: Date.now(),
      });

      const promise2 = manager.requestPermission({
        id: "test-4",
        sessionId: "s1",
        tool: "unknown_tool",
        input: {},
        resource: "r2",
        timestamp: Date.now(),
      });

      manager.denyAll();

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1.action).toBe("deny");
      expect(result2.action).toBe("deny");
    });
  });

  // ===== 10. write 工具在不同模式下的行为 =====
  describe("write 工具 securityMode 行为", () => {
    it("ToolContext 接受 securityMode 字段", () => {
      // 验证类型定义 — 编译时已验证，这里验证运行时可设置
      const ctx = {
        sessionId: "s1",
        messageId: "m1",
        cwd: "/tmp",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        securityMode: "auto" as SecurityMode,
      };
      expect(ctx.securityMode).toBe("auto");
    });

    it("securityMode 默认为 'ask'（未设置时）", () => {
      const ctx: Partial<import("../core/llm/tools").ToolContext> = {
        sessionId: "s1",
        messageId: "m1",
        cwd: "/tmp",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
      };
      // 模拟 write 工具中的逻辑
      const secMode = ctx.securityMode || "ask";
      expect(secMode).toBe("ask");
    });

    it("'ask' 模式下 shouldShowWriteConfirm 返回 true", () => {
      expect(shouldShowWriteConfirm("ask")).toBe(true);
    });

    it("'auto' 模式下 shouldShowWriteConfirm 返回 false", () => {
      expect(shouldShowWriteConfirm("auto")).toBe(false);
    });

    it("'full' 模式下 shouldShowWriteConfirm 返回 false", () => {
      expect(shouldShowWriteConfirm("full")).toBe(false);
    });
  });

  // ===== 集成场景 =====
  describe("集成场景", () => {
    it("场景：全局 ask，项目 A auto，项目 B full", () => {
      setGlobalSecurityMode("ask");
      setProjectSecurityMode("/project/a", "auto");
      setProjectSecurityMode("/project/b", "full");

      // 项目 A：auto → write 不弹 Diff
      expect(getEffectiveSecurityMode("/project/a")).toBe("auto");
      expect(shouldShowWriteConfirm(getEffectiveSecurityMode("/project/a"))).toBe(false);

      // 项目 B：full → write 不弹 Diff，bash 危险命令也放行
      expect(getEffectiveSecurityMode("/project/b")).toBe("full");
      expect(shouldShowWriteConfirm(getEffectiveSecurityMode("/project/b"))).toBe(false);
      expect(shouldCheckPermissions(getEffectiveSecurityMode("/project/b"))).toBe(false);

      // 项目 C：无覆盖 → ask → write 弹 Diff
      expect(getEffectiveSecurityMode("/project/c")).toBe("ask");
      expect(shouldShowWriteConfirm(getEffectiveSecurityMode("/project/c"))).toBe(true);
    });

    it("场景：full 模式下 .git 仍被保护", () => {
      // normalEvaluation = "deny" (来自 permission.ts 默认规则)
      const result = evaluateWithSecurityMode("full", "write", ".git/config", "deny");
      expect(result).toBe("deny");
    });

    it("场景：auto 模式下 bash npm install 自动放行", () => {
      // auto 模式，bash npm install 是安全的
      const result = evaluateWithSecurityMode("auto", "bash", "npm install", "ask");
      expect(result).toBe("allow");
    });

    it("场景：auto 模式下 bash rm -rf 仍需询问", () => {
      const result = evaluateWithSecurityMode("auto", "bash", "rm -rf node_modules", "ask");
      expect(result).toBe("ask");
    });

    it("场景：从 ask 切换到 full 后，权限检查完全跳过", () => {
      // 初始 ask
      setGlobalSecurityMode("ask");
      expect(shouldCheckPermissions(getEffectiveSecurityMode())).toBe(true);

      // 切换到 full
      setGlobalSecurityMode("full");
      expect(shouldCheckPermissions(getEffectiveSecurityMode())).toBe(false);
    });
  });
});
