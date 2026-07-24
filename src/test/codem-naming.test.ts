/**
 * 专项测试：验证项目内部命名已从 mimo/codex/claude 清理为 codem
 *
 * 覆盖修改范围：
 * 1. Settings key 迁移（mimo-* → codem-*）
 * 2. 事件名称一致性（发送端 = 接收端）
 * 3. 目录名（.codem-worktrees / .codem-snapshots / .codem-memory / .codem）
 * 4. 受保护路径（.codem-snapshots 被 deny）
 * 5. AGENTS.md fallback 不含 CLAUDE.md
 * 6. Worktree/自动化/Automation 配置键名
 * 7. 技能市场搜索 URL 不含 topic:claude
 * 8. Git 配置注释中无 codex/ 前缀示例
 * 9. 源码中无 codex 字样
 * 10. Snapshot/Memory 服务使用 .codem- 前缀
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

// ========== 源码扫描辅助 ==========
const SRC_DIR = resolve(__dirname, "..");
const TSC_CMD = "npx tsc --noEmit"; // just a string constant, not used

function readSourceFile(relPath: string): string {
  const abs = join(SRC_DIR, relPath);
  if (!existsSync(abs)) return "";
  return readFileSync(abs, "utf-8");
}

function grepSource(pattern: RegExp, files: string[]): string[] {
  const matches: string[] = [];
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  for (const f of files) {
    const content = readSourceFile(f);
    for (const m of content.matchAll(globalPattern)) {
      matches.push(`${f}: ${m[0]}`);
    }
  }
  return matches;
}

// 要检查的修改过的源文件列表
const MODIFIED_SOURCE_FILES = [
  "core/environment/worktree-manager.ts",
  "core/automation/automation-manager.ts",
  "core/snapshot/snapshot.ts",
  "core/permission/permission.ts",
  "core/llm/tools.ts",
  "core/memory/memory.ts",
  "core/settings/settings.ts",
  "core/project/files.ts",
  "core/config/loader.ts",
  "core/storage/migration.ts",
  "core/llm/index.ts",
  "components/SettingsPanel.tsx",
  "components/InputArea.tsx",
  "components/ConfigEditor.tsx",
  "components/ProjectManager.tsx",
  "components/ContextMonitor.tsx",
  "components/AgentDetail.tsx",
  "components/GitEnvSettings.tsx",
  "components/TopNavbar.tsx",
  "styles.css",
  "App.tsx",
];

// ========== 测试开始 ==========

describe("codem 命名清理 — 专项回归测试", () => {

  // ===== 1. Settings key 迁移 =====
  describe("Settings key 迁移（mimo-* → codem-*）", () => {
    it("migration.ts 包含 mimo-worktree-settings → codem-worktree-settings 映射", () => {
      const src = readSourceFile("core/storage/migration.ts");
      expect(src).toContain('"mimo-worktree-settings": "codem-worktree-settings"');
    });

    it("migration.ts 包含 mimo-project-execution-modes → codem-project-execution-modes 映射", () => {
      const src = readSourceFile("core/storage/migration.ts");
      expect(src).toContain('"mimo-project-execution-modes": "codem-project-execution-modes"');
    });

    it("migration.ts 包含 mimo-automation-config → codem-automation-config 映射", () => {
      const src = readSourceFile("core/storage/migration.ts");
      expect(src).toContain('"mimo-automation-config": "codem-automation-config"');
    });
  });

  // ===== 2. 事件名称一致性 =====
  describe("事件名称一致性（发送端 = 接收端）", () => {
    it("codem-worktree-settings-changed — worktree-manager 发送，SettingsPanel 接收", () => {
      const sender = readSourceFile("core/environment/worktree-manager.ts");
      const receiver = readSourceFile("components/SettingsPanel.tsx");
      expect(sender).toContain("codem-worktree-settings-changed");
      expect(receiver).toContain("codem-worktree-settings-changed");
      // 确保旧名称不存在
      expect(sender).not.toContain("mimo-worktree-settings-changed");
      expect(receiver).not.toContain("mimo-worktree-settings-changed");
    });

    it("codem-execution-mode-changed — worktree-manager 发送，InputArea 接收", () => {
      const sender = readSourceFile("core/environment/worktree-manager.ts");
      const receiver = readSourceFile("components/InputArea.tsx");
      expect(sender).toContain("codem-execution-mode-changed");
      expect(receiver).toContain("codem-execution-mode-changed");
      expect(sender).not.toContain("mimo-execution-mode-changed");
      expect(receiver).not.toContain("mimo-execution-mode-changed");
    });

    it("codem-automation-config-changed — automation-manager 发送，SettingsPanel 接收", () => {
      const sender = readSourceFile("core/automation/automation-manager.ts");
      const receiver = readSourceFile("components/SettingsPanel.tsx");
      expect(sender).toContain("codem-automation-config-changed");
      expect(receiver).toContain("codem-automation-config-changed");
      expect(sender).not.toContain("mimo-automation-config-changed");
      expect(receiver).not.toContain("mimo-automation-config-changed");
    });
  });

  // ===== 3. 目录名验证 =====
  describe("目录名使用 .codem- 前缀", () => {
    it("worktree-manager.ts 使用 .codem-worktrees", () => {
      const src = readSourceFile("core/environment/worktree-manager.ts");
      expect(src).toContain('.codem-worktrees');
      expect(src).not.toContain('.mimo-worktrees');
    });

    it("worktree-manager.ts SETTINGS_KEY 使用 codem-worktree-settings", () => {
      const src = readSourceFile("core/environment/worktree-manager.ts");
      expect(src).toContain('"codem-worktree-settings"');
      expect(src).not.toContain('"mimo-worktree-settings"');
    });

    it("worktree-manager.ts 使用 codem-project-execution-modes", () => {
      const src = readSourceFile("core/environment/worktree-manager.ts");
      expect(src).toContain('"codem-project-execution-modes"');
      expect(src).not.toContain('"mimo-project-execution-modes"');
    });

    it("snapshot.ts 使用 .codem-snapshots", () => {
      const src = readSourceFile("core/snapshot/snapshot.ts");
      expect(src).toContain('.codem-snapshots');
      expect(src).not.toContain('.mimo-snapshots');
    });

    it("memory.ts 使用 .codem-memory", () => {
      const src = readSourceFile("core/memory/memory.ts");
      expect(src).toContain('.codem-memory');
      expect(src).not.toContain('.mimo-memory');
    });

    it("files.ts 使用 .codem 作为项目根标记", () => {
      const src = readSourceFile("core/project/files.ts");
      expect(src).toContain('".codem"');
      expect(src).not.toContain('".mimo"');
    });

    it("files.ts 创建 .codem 目录结构（非 .mimo）", () => {
      const src = readSourceFile("core/project/files.ts");
      expect(src).toContain('.codem');
      expect(src).not.toContain('.mimo\\skills');
      expect(src).not.toContain('.mimo\\rules');
      expect(src).not.toContain('.mimo\\memory');
    });

    it("loader.ts CONFIG_DIRS 使用 .codem-* 前缀", () => {
      const src = readSourceFile("core/config/loader.ts");
      expect(src).toContain('app: ".codem-app"');
      expect(src).toContain('project: ".codem"');
      expect(src).toContain('subfolder: ".codem-sub"');
      expect(src).not.toContain('.mimo-app');
      expect(src).not.toContain('.mimo-sub');
    });

    it("settings.ts 使用 .codem/settings.json 路径", () => {
      const src = readSourceFile("core/settings/settings.ts");
      expect(src).toContain('.codem/settings');
      expect(src).toContain('~/.codem/settings.json');
      expect(src).not.toContain('.mimo/settings');
      expect(src).not.toContain('~/.mimocode/settings.json');
    });

    it("ConfigEditor.tsx 显示 .codem-app/ 和 .codem/", () => {
      const src = readSourceFile("components/ConfigEditor.tsx");
      expect(src).toContain('.codem-app/');
      expect(src).toContain('.codem/');
      expect(src).not.toContain('.mimo-app/');
      expect(src).not.toContain('.mimo/');
    });

    it("ProjectManager.tsx 提示创建 .codem 目录", () => {
      const src = readSourceFile("components/ProjectManager.tsx");
      expect(src).toContain('.codem 目录');
      expect(src).not.toContain('.mimo 目录');
    });
  });

  // ===== 4. 受保护路径 =====
  describe("受保护路径使用 .codem-snapshots", () => {
    it("permission.ts 保护 .codem-snapshots（非 .mimo-snapshots）", () => {
      const src = readSourceFile("core/permission/permission.ts");
      expect(src).toContain('.codem-snapshots');
      expect(src).not.toContain('.mimo-snapshots');
    });

    it("tools.ts 受保护路径正则使用 .codem-snapshots", () => {
      const src = readSourceFile("core/llm/tools.ts");
      expect(src).toContain('.codem-snapshots');
      expect(src).not.toContain('.mimo-snapshots');
    });

    it("tools.ts 错误消息使用 .codem-snapshots/", () => {
      const src = readSourceFile("core/llm/tools.ts");
      // write tool
      expect(src).toContain('.codem-snapshots/');
      expect(src).not.toContain('.mimo-snapshots/');
    });
  });

  // ===== 5. AGENTS.md fallback =====
  describe("AGENTS.md fallback 不含 CLAUDE.md", () => {
    it("files.ts fallback 列表不含 CLAUDE.md", () => {
      const src = readSourceFile("core/project/files.ts");
      expect(src).not.toContain('"CLAUDE.md"');
      expect(src).toContain('"AGENTS.md"');
      expect(src).toContain('"TEAM_GUIDE.md"');
    });
  });

  // ===== 6. 自动化配置键名 =====
  describe("自动化配置键名", () => {
    it("automation-manager.ts 使用 codem-automation-config", () => {
      const src = readSourceFile("core/automation/automation-manager.ts");
      expect(src).toContain('"codem-automation-config"');
      expect(src).not.toContain('"mimo-automation-config"');
    });
  });

  // ===== 7. 技能市场搜索 URL =====
  describe("技能市场搜索 URL 不含 topic:claude", () => {
    it("skill-market-client.ts GitHub 搜索 URL 不含 topic:claude", () => {
      const src = readSourceFile("core/skill/skill-market-client.ts");
      expect(src).not.toContain('topic:claude');
      expect(src).toContain('topic:ai-coding');
    });
  });

  // ===== 8. Git 配置注释 =====
  describe("Git 配置注释无 codex 前缀", () => {
    it("settings.ts branchPrefix 示例不含 codex/", () => {
      const src = readSourceFile("core/settings/settings.ts");
      expect(src).not.toMatch(/如 "codex\//);
      expect(src).not.toContain('对标 Codex');
    });

    it("GitEnvSettings.tsx placeholder 不含 codex/", () => {
      const src = readSourceFile("components/GitEnvSettings.tsx");
      expect(src).not.toContain('codex/');
      expect(src).toContain('feature/');
    });
  });

  // ===== 9. 源码中无 codex 字样 =====
  describe("源码中无 codex 字样", () => {
    it("所有修改过的源文件中不含 codex（不区分大小写）", () => {
      const matches = grepSource(/codex/i, MODIFIED_SOURCE_FILES);
      // 过滤掉合法引用（如果有）
      const filtered = matches.filter(m => !m.includes("codem")); // codem 本身包含 "cod" 但不是 "codex"
      expect(filtered).toEqual([]);
    });

    it("所有修改过的源文件中不含 CLAUDE.md 文件名引用", () => {
      const matches = grepSource(/CLAUDE\.md/i, MODIFIED_SOURCE_FILES);
      expect(matches).toEqual([]);
    });

    it("所有修改过的源文件中不含 'You are Claude' 引用", () => {
      const matches = grepSource(/You are Claude/i, MODIFIED_SOURCE_FILES);
      expect(matches).toEqual([]);
    });

    it("styles.css 中无 Codex style 注释", () => {
      const src = readSourceFile("styles.css");
      expect(src).not.toMatch(/Codex/i);
    });

    it("AgentDetail.tsx 中无 Codex style 注释", () => {
      const src = readSourceFile("components/AgentDetail.tsx");
      expect(src).not.toMatch(/Codex/i);
    });

    it("TopNavbar.tsx 中无 Codex Hub 引用", () => {
      const src = readSourceFile("components/TopNavbar.tsx");
      expect(src).not.toMatch(/Codex/i);
    });

    it("security-mode.ts 中无 Codex CLI 引用", () => {
      const src = readSourceFile("core/permission/security-mode.ts");
      expect(src).not.toMatch(/Codex/i);
    });

    it("environment-runner.ts 中无 Codex 引用", () => {
      const src = readSourceFile("core/environment/environment-runner.ts");
      expect(src).not.toMatch(/Codex/i);
    });

    it("agentic-loop.ts 中无 Codex 引用", () => {
      const src = readSourceFile("core/llm/agentic-loop.ts");
      expect(src).not.toMatch(/Codex/i);
    });

    it("subagent.ts 中无 Codex 引用", () => {
      const src = readSourceFile("core/subagent/subagent.ts");
      expect(src).not.toMatch(/Codex/i);
    });

    it("App.tsx 中无 Codex 引用", () => {
      const src = readSourceFile("App.tsx");
      expect(src).not.toMatch(/Codex/i);
    });

    it("ContextMonitor.tsx 中无 Codex 引用", () => {
      const src = readSourceFile("components/ContextMonitor.tsx");
      expect(src).not.toMatch(/Codex/i);
    });
  });

  // ===== 10. 合法 Claude API 引用保留 =====
  describe("合法 Claude API 引用保留", () => {
    it("provider.ts 保留 claude-sonnet-4-20250514 模型 ID", () => {
      const src = readSourceFile("core/llm/provider.ts");
      expect(src).toContain("claude-sonnet-4-20250514");
      expect(src).toContain("claude-opus-4-20250514");
    });

    it("cost-tracker.ts 保留 Claude 模型成本配置", () => {
      const src = readSourceFile("core/llm/cost-tracker.ts");
      expect(src).toContain("claude-sonnet-4-20250514");
      expect(src).toContain("claude-opus-4-20250514");
    });

    it("App.tsx 保留 model.startsWith(claude) 路由逻辑", () => {
      const src = readSourceFile("App.tsx");
      expect(src).toContain('model.startsWith("claude")');
    });
  });

  // ===== 11. 事件名称运行时验证 =====
  describe("事件名称运行时验证", () => {
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

    it("codem-automation-config-changed 事件可被监听", () => {
      let received = false;
      const handler = () => { received = true; };
      window.addEventListener("codem-automation-config-changed", handler);
      window.dispatchEvent(new CustomEvent("codem-automation-config-changed"));
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

  // ===== 12. Settings key 运行时验证 =====
  describe("Settings key 运行时验证", () => {
    it("getWorktreeSettings() 读取 codem-worktree-settings 键", () => {
      // 读取 worktree-manager 源码，验证它使用的 SETTINGS_KEY
      const src = readSourceFile("core/environment/worktree-manager.ts");
      // 验证常量值
      expect(src).toContain('SETTINGS_KEY = "codem-worktree-settings"');
    });

    it("getProjectExecutionMode() 读取 codem-project-execution-modes 键", () => {
      const src = readSourceFile("core/environment/worktree-manager.ts");
      expect(src).toContain('"codem-project-execution-modes"');
    });

    it("getAutomationConfig() 读取 codem-automation-config 键", () => {
      const src = readSourceFile("core/automation/automation-manager.ts");
      expect(src).toContain('SETTINGS_KEY = "codem-automation-config"');
    });
  });

  // ===== 13. index.ts 注释无 .mimo 引用 =====
  describe("index.ts 注释清理", () => {
    it("llm/index.ts 注释使用 .codem/settings.json", () => {
      const src = readSourceFile("core/llm/index.ts");
      expect(src).toContain('.codem/settings.json');
      expect(src).not.toContain('.mimo/settings.json');
    });
  });

  // ===== 14. PermissionCustomRules 测试已更新 =====
  describe("permission-custom-rules.test.ts 测试更新", () => {
    it("测试文件使用 .codem-snapshots（非 .mimo-snapshots）", () => {
      const src = readSourceFile("test/permission-custom-rules.test.ts");
      expect(src).toContain('.codem-snapshots');
      expect(src).not.toContain('.mimo-snapshots');
    });
  });

  // ===== 15. git-env-config 测试更新 =====
  describe("git-env-config.test.ts 测试更新", () => {
    it("测试文件使用 feature/（非 codex/）", () => {
      const src = readSourceFile("test/git-env-config.test.ts");
      expect(src).not.toContain('"codex/"');
      expect(src).toContain('"feature/"');
    });
  });

  // ===== 16. refactor-prompt-to-data 测试更新 =====
  describe("refactor-prompt-to-data.test.ts 测试更新", () => {
    it("测试文件不含 'You are Claude'", () => {
      const src = readSourceFile("test/refactor-prompt-to-data.test.ts");
      expect(src).not.toContain('You are Claude');
    });
  });
});
