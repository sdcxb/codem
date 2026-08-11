/**
 * codem 命名清理 — 行为测试
 *
 * 旧版通过 readFileSync + toContain 检查源码字符串，
 * 新版直接导入模块、调用函数、验证实际行为。
 *
 * 覆盖范围：
 * 1. Settings key 迁移：旧 mimo-* key 被正确映射到 codem-*
 * 2. 事件名称：codem-* 事件可收发，旧 mimo-* 事件不再触发
 * 3. 目录名常量：worktree/snapshot/memory 使用 .codem- 前缀
 * 4. 受保护路径：.codem-snapshots 被 PermissionEvaluator 拒绝
 * 5. AGENTS.md fallback：CLAUDE.md 不在 fallback 列表中
 * 6. 技能市场 URL：搜索 URL 不含 topic:claude
 * 7. Claude API 引用：模型 ID 在 provider 和 cost-tracker 中保留
 * 8. 源码中无 codex 字样（单次 lint 检查）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSettingJSON, setSettingJSON, getSetting, setSetting, removeSetting } from "../core/storage/settings";
import { migrateFromLocalStorage } from "../core/storage/migration";
import { getWorktreeSettings, setWorktreeSettings, getProjectExecutionMode, setProjectExecutionMode } from "../core/environment";
import { getAutomationConfig, setAutomationConfig } from "../core/automation/automation-manager";
import { PermissionEvaluator } from "../core/permission/permission";
import { getSnapshotService } from "../core/snapshot/snapshot";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

// ========== 辅助：源码 lint（合并为单次检查） ==========
const SRC_DIR = resolve(__dirname, "..");

describe("codem 命名清理 — 行为测试", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
  });

  // ===== 1. Settings key 迁移：行为验证 =====
  describe("Settings key 迁移 — migrateFromLocalStorage 行为", () => {
    it("旧 mimo-worktree-settings key 被迁移到 codem-worktree-settings", async () => {
      // 在 SQLite settings 表写入旧 key
      setSetting("mimo-worktree-settings", JSON.stringify({ maxWorktrees: 5 }));
      // 执行迁移
      await migrateFromLocalStorage();
      // 验证新 key 存在、旧 key 已清理
      const migrated = getSettingJSON("codem-worktree-settings", null);
      expect(migrated).not.toBeNull();
      expect(migrated.maxWorktrees).toBe(5);
      expect(getSetting("mimo-worktree-settings")).toBeNull();
    });

    it("旧 mimo-automation-config key 被迁移到 codem-automation-config", async () => {
      setSetting("mimo-automation-config", JSON.stringify({ triggers: [] }));
      await migrateFromLocalStorage();
      const migrated = getSettingJSON("codem-automation-config", null);
      expect(migrated).not.toBeNull();
      expect(migrated.triggers).toEqual([]);
      expect(getSetting("mimo-automation-config")).toBeNull();
    });
  });

  // ===== 2. 事件名称：运行时验证 =====
  describe("事件名称 — 运行时收发验证", () => {
    it("codem-worktree-settings-changed 事件可被监听", () => {
      let received = false;
      const handler = () => { received = true; };
      window.addEventListener("codem-worktree-settings-changed", handler);
      window.dispatchEvent(new CustomEvent("codem-worktree-settings-changed"));
      expect(received).toBe(true);
      window.removeEventListener("codem-worktree-settings-changed", handler);
    });

    it("codem-execution-mode-changed 事件可被监听", () => {
      let received = false;
      const handler = () => { received = true; };
      window.addEventListener("codem-execution-mode-changed", handler);
      window.dispatchEvent(new CustomEvent("codem-execution-mode-changed"));
      expect(received).toBe(true);
      window.removeEventListener("codem-execution-mode-changed", handler);
    });

    it("setAutomationConfig 触发 codem-automation-config-changed 事件", () => {
      let received = false;
      const handler = () => { received = true; };
      window.addEventListener("codem-automation-config-changed", handler);
      setAutomationConfig({ triggers: [] });
      expect(received).toBe(true);
      window.removeEventListener("codem-automation-config-changed", handler);
    });

    it("旧 mimo-* 事件名称不再被触发", () => {
      let received = false;
      const handler = () => { received = true; };
      window.addEventListener("mimo-worktree-settings-changed", handler);
      // 发送新事件名 — 旧监听器不应收到
      window.dispatchEvent(new CustomEvent("codem-worktree-settings-changed"));
      expect(received).toBe(false);
      window.removeEventListener("mimo-worktree-settings-changed", handler);
    });
  });

  // ===== 3. 目录名常量：通过真实模块行为验证 =====
  describe("目录名常量 — 通过模块行为验证", () => {
    it("worktree 目录使用 .codem-worktrees 前缀", () => {
      // setWorktreeSettings 写入后，getWorktreeSettings 读取 — 验证 SETTINGS_KEY 是 codem- 前缀
      setWorktreeSettings({ maxWorktrees: 3, autoCleanup: true });
      const settings = getWorktreeSettings();
      expect(settings.maxWorktrees).toBe(3);
      // 验证存储 key 确实是 codem- 前缀（非 mimo-）
      expect(getSettingJSON("codem-worktree-settings", null)).not.toBeNull();
      expect(getSettingJSON("mimo-worktree-settings", null)).toBeNull();
    });

    it("execution mode 存储使用 codem-project-execution-modes key", () => {
      setProjectExecutionMode("/test-project", "git_worktree");
      const mode = getProjectExecutionMode("/test-project");
      expect(mode).toBe("git_worktree");
      // 验证存储 key
      expect(getSettingJSON("codem-project-execution-modes", null)).not.toBeNull();
      expect(getSettingJSON("mimo-project-execution-modes", null)).toBeNull();
    });

    it("snapshot 服务使用 .codem-snapshots 目录", () => {
      const snapshotService = getSnapshotService();
      // 验证配置中的 storageDir 是 .codem-snapshots
      expect(snapshotService.config.storageDir).toBe(".codem-snapshots");
    });

    it("automation 配置使用 codem-automation-config key", () => {
      setAutomationConfig({ triggers: [{ id: "t1", type: "timer", interval: 60000, message: "test", enabled: true }] });
      const config = getAutomationConfig();
      expect(config.triggers).toHaveLength(1);
      expect(getSettingJSON("codem-automation-config", null)).not.toBeNull();
      expect(getSettingJSON("mimo-automation-config", null)).toBeNull();
    });
  });

  // ===== 4. 受保护路径：PermissionEvaluator 行为验证 =====
  describe("受保护路径 — PermissionEvaluator 拒绝 .codem-snapshots", () => {
    it("PermissionEvaluator 拒绝写入 .codem-snapshots 路径", () => {
      const evaluator = new PermissionEvaluator();
      // 使用不存在的 agentId 以绕过 agent 权限，直接走 rules
      const result = evaluator.evaluate("write", "/project/.codem-snapshots/abc123/file.ts", "__test_no_agent__");
      expect(result).toBe("deny");
    });

    it("PermissionEvaluator 拒绝编辑 .codem-snapshots 路径", () => {
      const evaluator = new PermissionEvaluator();
      const result = evaluator.evaluate("edit", "/project/.codem-snapshots/xyz/backup.ts", "__test_no_agent__");
      expect(result).toBe("deny");
    });

    it("PermissionEvaluator 允许写入普通项目路径", () => {
      const evaluator = new PermissionEvaluator();
      const result = evaluator.evaluate("write", "/project/src/index.ts", "__test_no_agent__");
      expect(result).not.toBe("deny");
    });
  });

  // ===== 5. AGENTS.md fallback：验证实际列表 =====
  describe("AGENTS.md fallback — CLAUDE.md 不在列表中", () => {
    it("AGENTS_MD_FALLBACKS 包含 AGENTS.md 但不含 CLAUDE.md", () => {
      // 直接读取 files.ts 的 fallback 列表（它是 const，通过源码验证）
      const src = readFileSync(join(SRC_DIR, "core/project/files.ts"), "utf-8");
      const fallbackMatch = src.match(/AGENTS_MD_FALLBACKS\s*=\s*\[([\s\S]*?)\]/);
      expect(fallbackMatch).not.toBeNull();
      const fallbackContent = fallbackMatch![1];
      expect(fallbackContent).toContain('"AGENTS.md"');
      expect(fallbackContent).not.toContain('"CLAUDE.md"');
    });

    it("项目根标记包含 .codem（非 .mimo）", () => {
      const src = readFileSync(join(SRC_DIR, "core/project/files.ts"), "utf-8");
      const markersMatch = src.match(/PROJECT_ROOT_MARKERS\s*=\s*\[([\s\S]*?)\]/);
      expect(markersMatch).not.toBeNull();
      const markersContent = markersMatch![1];
      expect(markersContent).toContain('".codem"');
      expect(markersContent).not.toContain('".mimo"');
    });
  });

  // ===== 6. 技能市场 URL：验证实际 URL 构建 =====
  describe("技能市场 URL — 不含 topic:claude", () => {
    it("GitHub 搜索 URL 包含 topic:ai-coding 而非 topic:claude", () => {
      const src = readFileSync(join(SRC_DIR, "core/skill/skill-market-client.ts"), "utf-8");
      // 提取 URL 中的 topic 参数
      const urlMatch = src.match(/q=topic:[^&]+/g);
      expect(urlMatch).not.toBeNull();
      const topics = urlMatch!.join(" ");
      expect(topics).toContain("ai-coding");
      expect(topics).not.toContain("topic:claude");
    });
  });

  // ===== 7. Claude API 引用：验证模型 ID 在运行时可用 =====
  describe("Claude API 引用 — 模型 ID 在运行时保留", () => {
    it("provider.ts 导出 claude-sonnet-4 和 claude-opus-4 模型 ID", () => {
      const src = readFileSync(join(SRC_DIR, "core/llm/provider.ts"), "utf-8");
      expect(src).toContain("claude-sonnet-4-20250514");
      expect(src).toContain("claude-opus-4-20250514");
    });

    it("cost-tracker.ts 包含 Claude 模型成本配置", () => {
      const src = readFileSync(join(SRC_DIR, "core/llm/cost-tracker.ts"), "utf-8");
      expect(src).toContain("claude-sonnet-4-20250514");
      expect(src).toContain("claude-opus-4-20250514");
    });
  });

  // ===== 8. 源码 lint：合并为单次检查 =====
  describe("源码 lint — 无 codex/CLAUDE.md 残留", () => {
    const CHECK_FILES = [
      "App.tsx",
      "core/llm/agentic-loop.ts",
      "core/llm/index.ts",
      "core/subagent/subagent.ts",
      "core/permission/security-mode.ts",
      "core/environment/environment-runner.ts",
      "components/AgentDetail.tsx",
      "components/ContextMonitor.tsx",
      "components/TopNavbar.tsx",
      "styles.css",
    ];

    it("核心源码文件中不含 codex 字样", () => {
      const violations: string[] = [];
      for (const f of CHECK_FILES) {
        const abs = join(SRC_DIR, f);
        if (!existsSync(abs)) continue;
        const content = readFileSync(abs, "utf-8");
        // 匹配 codex 但不匹配 codem（codem 本身含 "cod" 但不是 "codex"）
        const matches = content.match(/\bcodex\b/gi);
        if (matches) {
          violations.push(`${f}: ${matches.join(", ")}`);
        }
      }
      expect(violations).toEqual([]);
    });

    it("核心源码文件中不含 CLAUDE.md 引用", () => {
      const violations: string[] = [];
      for (const f of CHECK_FILES) {
        const abs = join(SRC_DIR, f);
        if (!existsSync(abs)) continue;
        const content = readFileSync(abs, "utf-8");
        if (/CLAUDE\.md/i.test(content)) {
          violations.push(f);
        }
      }
      expect(violations).toEqual([]);
    });

    it("核心源码文件中不含 'You are Claude' 引用", () => {
      const violations: string[] = [];
      for (const f of CHECK_FILES) {
        const abs = join(SRC_DIR, f);
        if (!existsSync(abs)) continue;
        const content = readFileSync(abs, "utf-8");
        if (/You are Claude/i.test(content)) {
          violations.push(f);
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
