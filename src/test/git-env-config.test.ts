/**
 * 测试：Git 配置 + 环境脚本 功能枚举测试
 *
 * 验证引入 GitConfig（G series）和 EnvironmentConfig（ENV series）后：
 *   A. 数据模型持久化 — 配置存储/读取/覆盖/删除
 *   B. System Prompt 注入 — Git 偏好和 Env 信息正确出现在系统提示中
 *   C. 环境脚本执行 — setup/cleanup/custom 操作的调用和事件分发
 *   D. 项目切换联动 — 切换项目时 setup/cleanup 的触发顺序
 *   E. 边界场景 — 空配置/异常值/特殊字符/大数据量
 *   F. 对对话的影响 — 配置变更后 system prompt 重建
 *
 * 改动影响文件：
 *   - src/core/settings/settings.ts (GitConfig, EnvironmentConfig, CustomOperation)
 *   - src/core/prompt/prompt.ts (gitConfig, environmentConfig 注入)
 *   - src/core/llm/index.ts (加载 codem-git-config, codem-env-config)
 *   - src/core/environment/environment-runner.ts (脚本执行)
 *   - src/App.tsx (项目切换时 runSetupScript/runCleanupScript)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSetting, setSetting, getSettingJSON, setSettingJSON, removeSetting } from "../core/storage/settings";
import { buildSystemPrompt, type SystemPromptConfig } from "../core/prompt/prompt";
import type { GitConfig, EnvironmentConfig, CustomOperation } from "../core/settings/settings";
import type { AgentDefinition } from "../core/agent/agent";

// ========== Mock Agent ==========
const mockAgent: AgentDefinition = {
  id: "test",
  name: "Test Agent",
  description: "Test agent for unit tests",
  mode: "primary",
  prompt: "You are a test agent.",
  permissions: [],
};

const basePromptConfig: Omit<SystemPromptConfig, "gitConfig" | "environmentConfig"> = {
  agent: mockAgent,
  workingDirectory: "/test/project",
  date: "2026-07-21T00:00:00.000Z",
  modelInfo: "test/model",
};

// ========== Mock executeCommand for environment-runner ==========
vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
}));

describe("Git 配置 + 环境脚本 — 枚举测试", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════
  // A. GitConfig 数据模型持久化
  // ═══════════════════════════════════════════════════════════
  describe("A. GitConfig 数据模型持久化", () => {
    it("A1: 空配置 — 默认值为 undefined", () => {
      const config = getSettingJSON<GitConfig | null>("codem-git-config", null);
      expect(config).toBeNull();
    });

    it("A2: 完整配置 — 所有字段写入和读取", () => {
      const config: GitConfig = {
        branchPrefix: "feature/",
        mergeMethod: "squash",
        forcePush: false,
        draftPR: true,
        commitMessageInstructions: "Use conventional commits format",
        prTitleInstructions: "Prefix with [WIP] if draft",
        prDescriptionInstructions: "Include test plan section",
      };
      setSettingJSON("codem-git-config", config);
      const result = getSettingJSON<GitConfig>("codem-git-config", null as any);
      expect(result).toEqual(config);
    });

    it("A3: 部分配置 — 仅设置部分字段", () => {
      const config: GitConfig = {
        branchPrefix: "feat/",
        forcePush: false,
      };
      setSettingJSON("codem-git-config", config);
      const result = getSettingJSON<GitConfig>("codem-git-config", null as any);
      expect(result.branchPrefix).toBe("feat/");
      expect(result.forcePush).toBe(false);
      expect(result.mergeMethod).toBeUndefined();
      expect(result.draftPR).toBeUndefined();
    });

    it("A4: 覆盖配置 — 修改后读取为新值", () => {
      setSettingJSON("codem-git-config", { branchPrefix: "old/" });
      setSettingJSON("codem-git-config", { branchPrefix: "new/" });
      const result = getSettingJSON<GitConfig>("codem-git-config", null as any);
      expect(result.branchPrefix).toBe("new/");
    });

    it("A5: 删除配置 — removeSetting 后读取返回默认值", () => {
      setSettingJSON("codem-git-config", { branchPrefix: "feature/" });
      removeSetting("codem-git-config");
      const result = getSettingJSON<GitConfig | null>("codem-git-config", null);
      expect(result).toBeNull();
    });

    it("A6: mergeMethod 枚举值 — merge/squash/rebase 均可存储", () => {
      for (const method of ["merge", "squash", "rebase"] as const) {
        setSettingJSON("codem-git-config", { mergeMethod: method });
        const result = getSettingJSON<GitConfig>("codem-git-config", null as any);
        expect(result.mergeMethod).toBe(method);
      }
    });

    it("A7: forcePush 布尔值 — true/false/undefined 三态", () => {
      // false
      setSettingJSON("codem-git-config", { forcePush: false });
      expect(getSettingJSON<GitConfig>("codem-git-config", null as any).forcePush).toBe(false);
      // true
      setSettingJSON("codem-git-config", { forcePush: true });
      expect(getSettingJSON<GitConfig>("codem-git-config", null as any).forcePush).toBe(true);
      // undefined (不设置该字段)
      setSettingJSON("codem-git-config", { branchPrefix: "x/" });
      expect(getSettingJSON<GitConfig>("codem-git-config", null as any).forcePush).toBeUndefined();
    });

    it("A8: 特殊字符在指令字段中 — 中文/emoji/换行", () => {
      const config: GitConfig = {
        commitMessageInstructions: "使用中文提交信息，格式：feat(scope): 描述 ⚡",
        prTitleInstructions: "标题用中文，第一行\n第二行",
        prDescriptionInstructions: "描述包含「特殊」引号和...省略号",
      };
      setSettingJSON("codem-git-config", config);
      const result = getSettingJSON<GitConfig>("codem-git-config", null as any);
      expect(result.commitMessageInstructions).toContain("中文");
      expect(result.commitMessageInstructions).toContain("⚡");
      expect(result.prTitleInstructions).toContain("\n");
      expect(result.prDescriptionInstructions).toContain("「特殊」");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. EnvironmentConfig 数据模型持久化
  // ═══════════════════════════════════════════════════════════
  describe("B. EnvironmentConfig 数据模型持久化", () => {
    it("B1: 空配置 — 默认值", () => {
      const config = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null);
      expect(config).toBeNull();
    });

    it("B2: 完整配置 — setup/cleanup/customOperations 全部写入", () => {
      const config: EnvironmentConfig = {
        setupScript: "npm install",
        cleanupScript: "npm run cleanup",
        customOperations: [
          { id: "build", name: "构建项目", command: "npm run build", icon: "🔨" },
          { id: "test", name: "运行测试", command: "npm test", icon: "🧪" },
          { id: "dev", name: "启动开发服务器", command: "npm run dev" },
        ],
      };
      setSettingJSON("codem-env-config", config);
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.setupScript).toBe("npm install");
      expect(result.cleanupScript).toBe("npm run cleanup");
      expect(result.customOperations).toHaveLength(3);
      expect(result.customOperations![0].id).toBe("build");
      expect(result.customOperations![0].icon).toBe("🔨");
    });

    it("B3: 仅 setupScript — 其他字段为 undefined", () => {
      setSettingJSON("codem-env-config", { setupScript: "pnpm install" });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.setupScript).toBe("pnpm install");
      expect(result.cleanupScript).toBeUndefined();
      expect(result.customOperations).toBeUndefined();
    });

    it("B4: 仅 cleanupScript", () => {
      setSettingJSON("codem-env-config", { cleanupScript: "docker compose down" });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.cleanupScript).toBe("docker compose down");
      expect(result.setupScript).toBeUndefined();
    });

    it("B5: 仅 customOperations（空数组）", () => {
      setSettingJSON("codem-env-config", { customOperations: [] });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.customOperations).toEqual([]);
    });

    it("B6: customOperations 中的特殊字符命令", () => {
      const config: EnvironmentConfig = {
        setupScript: "echo '你好世界' && npm install",
        customOperations: [
          { id: "custom1", name: "自定义操作", command: "python -c \"print('你好')\"", icon: "🐍" },
        ],
      };
      setSettingJSON("codem-env-config", config);
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.setupScript).toContain("你好世界");
      expect(result.customOperations![0].command).toContain("print('你好')");
    });

    it("B7: 覆盖配置 — 从有到无", () => {
      setSettingJSON("codem-env-config", {
        setupScript: "npm install",
        cleanupScript: "npm run cleanup",
      });
      setSettingJSON("codem-env-config", { setupScript: "pnpm install" });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.setupScript).toBe("pnpm install");
      expect(result.cleanupScript).toBeUndefined();
    });

    it("B8: 大量 customOperations — 50 个操作", () => {
      const ops: CustomOperation[] = Array.from({ length: 50 }, (_, i) => ({
        id: `op-${i}`,
        name: `操作 ${i}`,
        command: `echo ${i}`,
      }));
      setSettingJSON("codem-env-config", { customOperations: ops });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.customOperations).toHaveLength(50);
      expect(result.customOperations![49].id).toBe("op-49");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. System Prompt 注入测试
  // ═══════════════════════════════════════════════════════════
  describe("C. System Prompt 注入 Git/Env 配置", () => {
    it("C1: 无 Git 配置 — prompt 中不出现 Git Preferences 段", () => {
      const prompt = buildSystemPrompt(basePromptConfig);
      expect(prompt).not.toContain("Git Preferences");
    });

    it("C2: 无 Env 配置 — prompt 中不出现 Environment Scripts 段", () => {
      const prompt = buildSystemPrompt(basePromptConfig);
      expect(prompt).not.toContain("Environment Scripts");
    });

    it("C3: 有 branchPrefix — prompt 中出现分支前缀规则", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { branchPrefix: "feature/" },
      });
      expect(prompt).toContain("Git Preferences");
      expect(prompt).toContain('feature/');
      expect(prompt).toContain("feature/feature-name");
    });

    it("C4: 有 mergeMethod=squash — prompt 中出现 squash and merge", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { mergeMethod: "squash" },
      });
      expect(prompt).toContain("squash and merge");
    });

    it("C5: 有 mergeMethod=merge — prompt 中出现 merge commit", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { mergeMethod: "merge" },
      });
      expect(prompt).toContain("merge commit");
    });

    it("C6: 有 mergeMethod=rebase — prompt 中出现 rebase and merge", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { mergeMethod: "rebase" },
      });
      expect(prompt).toContain("rebase and merge");
    });

    it("C7: forcePush=false — prompt 中明确禁止 force push", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { forcePush: false },
      });
      expect(prompt).toContain("NEVER");
      expect(prompt).toContain("force push");
    });

    it("C8: forcePush=true — prompt 中允许 force push 但需确认", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { forcePush: true },
      });
      expect(prompt).toContain("Force push is allowed");
      expect(prompt).toContain("confirmation");
    });

    it("C9: forcePush=undefined — prompt 中不出现 force push 相关规则", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { branchPrefix: "x/" },
      });
      expect(prompt).not.toContain("force push");
    });

    it("C10: draftPR=true — prompt 中出现 draft PR 规则", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { draftPR: true },
      });
      expect(prompt).toContain("draft PR");
    });

    it("C11: commitMessageInstructions — prompt 中出现提交信息风格指令", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { commitMessageInstructions: "Use conventional commits" },
      });
      expect(prompt).toContain("Commit message style");
      expect(prompt).toContain("Use conventional commits");
    });

    it("C12: prTitleInstructions — prompt 中出现 PR 标题风格指令", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { prTitleInstructions: "Prefix with [FEAT]" },
      });
      expect(prompt).toContain("PR title style");
      expect(prompt).toContain("[FEAT]");
    });

    it("C13: prDescriptionInstructions — prompt 中出现 PR 描述风格指令", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { prDescriptionInstructions: "Include screenshots" },
      });
      expect(prompt).toContain("PR description style");
      expect(prompt).toContain("Include screenshots");
    });

    it("C14: 完整 Git 配置 — 所有规则同时出现", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: {
          branchPrefix: "feat/",
          mergeMethod: "squash",
          forcePush: false,
          draftPR: true,
          commitMessageInstructions: "conventional commits",
          prTitleInstructions: "include ticket number",
          prDescriptionInstructions: "include test plan",
        },
      });
      expect(prompt).toContain("feat/");
      expect(prompt).toContain("squash and merge");
      expect(prompt).toContain("NEVER");
      expect(prompt).toContain("draft PR");
      expect(prompt).toContain("conventional commits");
      expect(prompt).toContain("include ticket number");
      expect(prompt).toContain("include test plan");
    });

    it("C15: 有 setupScript — prompt 中出现 setup script 信息", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        environmentConfig: { setupScript: "npm install" },
      });
      expect(prompt).toContain("Environment Scripts");
      expect(prompt).toContain("npm install");
      expect(prompt).toContain("Setup script");
    });

    it("C16: 有 cleanupScript — prompt 中出现 cleanup script 信息", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        environmentConfig: { cleanupScript: "docker compose down" },
      });
      expect(prompt).toContain("Cleanup script");
      expect(prompt).toContain("docker compose down");
    });

    it("C17: 有 customOperations — prompt 中列出所有操作", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        environmentConfig: {
          customOperations: [
            { id: "build", name: "构建", command: "npm run build" },
            { id: "test", name: "测试", command: "npm test" },
          ],
        },
      });
      expect(prompt).toContain("构建");
      expect(prompt).toContain("npm run build");
      expect(prompt).toContain("测试");
      expect(prompt).toContain("npm test");
    });

    it("C18: 空 customOperations 数组 — prompt 中不出现操作列表", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        environmentConfig: { customOperations: [] },
      });
      // setupScript/cleanupScript 都没有，所以整个段不应该出现
      expect(prompt).not.toContain("Environment Scripts");
    });

    it("C19: Git + Env 配置同时存在 — 两段都出现且不冲突", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { branchPrefix: "feature/", forcePush: false },
        environmentConfig: { setupScript: "npm install", cleanupScript: "npm run clean" },
      });
      expect(prompt).toContain("Git Preferences");
      expect(prompt).toContain("Environment Scripts");
      expect(prompt).toContain("feature/");
      expect(prompt).toContain("npm install");
    });

    it("C20: Git 配置中含特殊字符 — 不破坏 prompt 结构", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: {
          commitMessageInstructions: "使用中文，格式：feat(scope): 描述 🚀",
        },
      });
      // 确保特殊字符不导致 section 分隔符断裂
      const sections = prompt.split("\n\n---\n\n");
      expect(sections.length).toBeGreaterThan(5);
      expect(prompt).toContain("🚀");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. 环境脚本执行测试 (environment-runner)
  // ═══════════════════════════════════════════════════════════
  describe("D. 环境脚本执行 (environment-runner)", () => {
    /**
     * 由于 environment-runner 内部动态 import file-api，
     * 我们需要先设置 mock，再动态 import runner。
     */

    async function loadRunner() {
      // 确保使用最新的 mock
      const { executeCommand } = await import("../core/file-api");
      const runner = await import("../core/environment/environment-runner");
      return { runner, executeCommand };
    }

    it("D1: 无 setupScript — runSetupScript 返回 null", async () => {
      const { runner } = await loadRunner();
      const result = await runner.runSetupScript("/test");
      expect(result).toBeNull();
    });

    it("D2: 无 cleanupScript — runCleanupScript 返回 null", async () => {
      const { runner } = await loadRunner();
      const result = await runner.runCleanupScript("/test");
      expect(result).toBeNull();
    });

    it("D3: 有 setupScript — 调用 executeCommand 并返回成功结果", async () => {
      setSettingJSON("codem-env-config", { setupScript: "npm install" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "added 100 packages",
        stderr: "",
        exitCode: 0,
      });

      const result = await runner.runSetupScript("/project");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.stdout).toBe("added 100 packages");
      expect(executeCommand).toHaveBeenCalledWith("npm install", "/project");
    });

    it("D4: setupScript 执行失败 — 返回 success=false", async () => {
      setSettingJSON("codem-env-config", { setupScript: "npm install" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "Error: network timeout",
        exitCode: 1,
      });

      const result = await runner.runSetupScript("/project");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.stderr).toContain("network timeout");
      expect(result!.exitCode).toBe(1);
    });

    it("D5: setupScript 抛异常 — 返回 success=false 和错误消息", async () => {
      setSettingJSON("codem-env-config", { setupScript: "bad-command" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockRejectedValue(new Error("Command not found"));

      const result = await runner.runSetupScript("/project");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.stderr).toContain("Command not found");
      expect(result!.exitCode).toBe(-1);
    });

    it("D6: cleanupScript — 调用 executeCommand 并返回结果", async () => {
      setSettingJSON("codem-env-config", { cleanupScript: "docker compose down" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "stopped",
        stderr: "",
        exitCode: 0,
      });

      const result = await runner.runCleanupScript("/project");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      // timeoutMs (30000) is handled by Promise.race in runScript, not passed to executeCommand
      expect(executeCommand).toHaveBeenCalledWith("docker compose down", "/project");
    });

    it("D7: customOperation 存在 — 按 ID 找到并执行", async () => {
      setSettingJSON("codem-env-config", {
        customOperations: [
          { id: "build", name: "构建", command: "npm run build", icon: "🔨" },
          { id: "test", name: "测试", command: "npm test" },
        ],
      });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "build success",
        stderr: "",
        exitCode: 0,
      });

      const result = await runner.runCustomOperation("build", "/project");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.stdout).toBe("build success");
      expect(executeCommand).toHaveBeenCalledWith("npm run build", "/project");
    });

    it("D8: customOperation 不存在 — 返回 null", async () => {
      setSettingJSON("codem-env-config", {
        customOperations: [{ id: "build", name: "构建", command: "npm run build" }],
      });
      const { runner } = await loadRunner();

      const result = await runner.runCustomOperation("nonexistent", "/project");
      expect(result).toBeNull();
    });

    it("D9: 无任何环境配置 — getCustomOperations 返回空数组", async () => {
      const { runner } = await loadRunner();
      const ops = runner.getCustomOperations();
      expect(ops).toEqual([]);
    });

    it("D10: 有 customOperations — getCustomOperations 返回完整列表", async () => {
      setSettingJSON("codem-env-config", {
        customOperations: [
          { id: "a", name: "A", command: "echo a" },
          { id: "b", name: "B", command: "echo b" },
        ],
      });
      const { runner } = await loadRunner();
      const ops = runner.getCustomOperations();
      expect(ops).toHaveLength(2);
      expect(ops[0].id).toBe("a");
      expect(ops[1].id).toBe("b");
    });

    it("D11: setupScript 为空白字符串 — 视为无脚本，返回 null", async () => {
      setSettingJSON("codem-env-config", { setupScript: "   " });
      const { runner } = await loadRunner();
      const result = await runner.runSetupScript("/project");
      expect(result).toBeNull();
    });

    it("D12: setupScript 为空字符串 — 视为无脚本，返回 null", async () => {
      setSettingJSON("codem-env-config", { setupScript: "" });
      const { runner } = await loadRunner();
      const result = await runner.runSetupScript("/project");
      expect(result).toBeNull();
    });

    it("D13: 脚本执行后 — 分发 codem-env-script-result 事件", async () => {
      setSettingJSON("codem-env-config", { setupScript: "echo hello" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "hello",
        stderr: "",
        exitCode: 0,
      });

      const events: any[] = [];
      const handler = (e: Event) => events.push((e as CustomEvent).detail);
      window.addEventListener("codem-env-script-result", handler);

      await runner.runSetupScript("/project");

      window.removeEventListener("codem-env-script-result", handler);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("setup");
      expect(events[0].command).toBe("echo hello");
      expect(events[0].cwd).toBe("/project");
      expect(events[0].success).toBe(true);
    });

    it("D14: cleanup 脚本执行后 — 分发 type=cleanup 事件", async () => {
      setSettingJSON("codem-env-config", { cleanupScript: "echo cleanup" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "cleanup done",
        stderr: "",
        exitCode: 0,
      });

      const events: any[] = [];
      const handler = (e: Event) => events.push((e as CustomEvent).detail);
      window.addEventListener("codem-env-script-result", handler);

      await runner.runCleanupScript("/project");

      window.removeEventListener("codem-env-script-result", handler);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("cleanup");
    });

    it("D15: customOperation 执行后 — 分发 type=custom 事件含操作名", async () => {
      setSettingJSON("codem-env-config", {
        customOperations: [{ id: "build", name: "构建项目", command: "npm run build" }],
      });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "done",
        stderr: "",
        exitCode: 0,
      });

      const events: any[] = [];
      const handler = (e: Event) => events.push((e as CustomEvent).detail);
      window.addEventListener("codem-env-script-result", handler);

      await runner.runCustomOperation("build", "/project");

      window.removeEventListener("codem-env-script-result", handler);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("custom");
      expect(events[0].operationName).toBe("构建项目");
    });

    // ===== 超时保护测试 =====
    it("D16: setupScript 超时 — executeCommand 不返回时，60s 后超时并返回失败", async () => {
      setSettingJSON("codem-env-config", { setupScript: "npm install" });
      const { runner, executeCommand } = await loadRunner();
      // 模拟永不返回的命令（挂起的进程）
      vi.mocked(executeCommand).mockReturnValue(new Promise(() => {}));

      vi.useFakeTimers();
      const promise = runner.runSetupScript("/project");
      vi.advanceTimersByTime(60000);
      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.stderr).toContain("timed out");
      expect(result!.exitCode).toBe(-1);
      vi.useRealTimers();
    });

    it("D17: cleanupScript 超时 — executeCommand 不返回时，30s 后超时并返回失败", async () => {
      setSettingJSON("codem-env-config", { cleanupScript: "docker compose down" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockReturnValue(new Promise(() => {}));

      vi.useFakeTimers();
      const promise = runner.runCleanupScript("/project");
      vi.advanceTimersByTime(30000);
      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.stderr).toContain("timed out");
      expect(result!.exitCode).toBe(-1);
      vi.useRealTimers();
    });

    it("D18: customOperation 超时 — executeCommand 不返回时，300s 后超时并返回失败", async () => {
      setSettingJSON("codem-env-config", {
        customOperations: [{ id: "build", name: "构建", command: "npm run build" }],
      });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockReturnValue(new Promise(() => {}));

      vi.useFakeTimers();
      const promise = runner.runCustomOperation("build", "/project");
      vi.advanceTimersByTime(300000);
      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.stderr).toContain("timed out");
      vi.useRealTimers();
    });

    it("D19: setupScript 超时前完成 — 不触发超时，正常返回结果", async () => {
      setSettingJSON("codem-env-config", { setupScript: "npm install" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "done",
        stderr: "",
        exitCode: 0,
      });

      vi.useFakeTimers();
      const promise = runner.runSetupScript("/project");
      // 只推进 10s，还没到 60s 超时
      vi.advanceTimersByTime(10000);
      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.stdout).toBe("done");
      vi.useRealTimers();
    });

    it("D20: 超时后分发事件 — 事件中包含超时错误信息", async () => {
      setSettingJSON("codem-env-config", { setupScript: "npm install" });
      const { runner, executeCommand } = await loadRunner();
      vi.mocked(executeCommand).mockReturnValue(new Promise(() => {}));

      const events: any[] = [];
      const handler = (e: Event) => events.push((e as CustomEvent).detail);
      window.addEventListener("codem-env-script-result", handler);

      vi.useFakeTimers();
      const promise = runner.runSetupScript("/project");
      vi.advanceTimersByTime(60000);
      await promise;

      window.removeEventListener("codem-env-script-result", handler);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("setup");
      expect(events[0].success).toBe(false);
      expect(events[0].stderr).toContain("timed out");
      vi.useRealTimers();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // E. 配置变更对对话的影响
  // ═══════════════════════════════════════════════════════════
  describe("E. 配置变更对对话的影响", () => {
    it("E1: 配置不存在时 — system prompt 正常生成，不含 Git/Env 段", () => {
      const prompt = buildSystemPrompt(basePromptConfig);
      expect(prompt).not.toContain("Git Preferences");
      expect(prompt).not.toContain("Environment Scripts");
      // 核心段仍然存在
      expect(prompt).toContain("Identity");
      expect(prompt).toContain("Available Tools");
    });

    it("E2: 保存 Git 配置后 — 新的 system prompt 包含 Git 规则", () => {
      // 第一次：无配置
      const prompt1 = buildSystemPrompt(basePromptConfig);
      expect(prompt1).not.toContain("Git Preferences");

      // 保存配置
      setSettingJSON("codem-git-config", { branchPrefix: "feat/", forcePush: false });

      // 第二次：有配置（模拟 buildSystemPromptAsync 的行为）
      const gitConfig = getSettingJSON<GitConfig | null>("codem-git-config", null) || undefined;
      const prompt2 = buildSystemPrompt({ ...basePromptConfig, gitConfig });
      expect(prompt2).toContain("Git Preferences");
      expect(prompt2).toContain("feat/");
    });

    it("E3: 保存 Env 配置后 — 新的 system prompt 包含 Env 段", () => {
      const prompt1 = buildSystemPrompt(basePromptConfig);
      expect(prompt1).not.toContain("Environment Scripts");

      setSettingJSON("codem-env-config", { setupScript: "npm install" });

      const envConfig = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null) || undefined;
      const prompt2 = buildSystemPrompt({ ...basePromptConfig, environmentConfig: envConfig });
      expect(prompt2).toContain("Environment Scripts");
      expect(prompt2).toContain("npm install");
    });

    it("E4: 修改 Git 配置后 — prompt 中规则更新", () => {
      setSettingJSON("codem-git-config", { branchPrefix: "old/" });
      const gc1 = getSettingJSON<GitConfig | null>("codem-git-config", null) || undefined;
      const prompt1 = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc1 });
      expect(prompt1).toContain("old/");

      setSettingJSON("codem-git-config", { branchPrefix: "new/" });
      const gc2 = getSettingJSON<GitConfig | null>("codem-git-config", null) || undefined;
      const prompt2 = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc2 });
      expect(prompt2).toContain("new/");
      expect(prompt2).not.toContain("old/");
    });

    it("E5: 删除 Git 配置后 — prompt 不再包含 Git 段", () => {
      setSettingJSON("codem-git-config", { branchPrefix: "feat/" });
      removeSetting("codem-git-config");
      const gc = getSettingJSON<GitConfig | null>("codem-git-config", null);
      const prompt = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc || undefined });
      expect(prompt).not.toContain("Git Preferences");
    });

    it("E6: Git 配置和 Env 配置独立 — 互不影响", () => {
      setSettingJSON("codem-git-config", { branchPrefix: "feat/" });
      // 不设置 env config
      const gc = getSettingJSON<GitConfig | null>("codem-git-config", null) || undefined;
      const ec = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null) || undefined;

      const prompt = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc, environmentConfig: ec });
      expect(prompt).toContain("Git Preferences");
      expect(prompt).toContain("feat/");
      // env 段不应该出现
      expect(prompt).not.toContain("Environment Scripts");
    });

    it("E7: workingDirectory 仍正常注入 — 不受 Git/Env 影响", () => {
      const prompt = buildSystemPrompt({
        ...basePromptConfig,
        gitConfig: { branchPrefix: "x/" },
        environmentConfig: { setupScript: "echo hi" },
      });
      expect(prompt).toContain("/test/project");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. 边界场景和异常处理
  // ═══════════════════════════════════════════════════════════
  describe("F. 边界场景和异常处理", () => {
    it("F1: GitConfig 所有字段为 undefined — 等价于空对象", () => {
      setSettingJSON("codem-git-config", {});
      const gc = getSettingJSON<GitConfig | null>("codem-git-config", null);
      const prompt = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc || undefined });
      // 空对象不生成任何规则
      expect(prompt).not.toContain("Git Preferences");
    });

    it("F2: EnvironmentConfig 所有字段为 undefined — 等价于空对象", () => {
      setSettingJSON("codem-env-config", {});
      const ec = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null);
      const prompt = buildSystemPrompt({ ...basePromptConfig, environmentConfig: ec || undefined });
      expect(prompt).not.toContain("Environment Scripts");
    });

    it("F3: JSON 解析失败 — getSettingJSON 返回默认值", () => {
      setSetting("codem-git-config", "{invalid json}");
      const result = getSettingJSON<GitConfig>("codem-git-config", { branchPrefix: "default/" });
      expect(result.branchPrefix).toBe("default/");
    });

    it("F4: customOperation 缺少 id — 仍可存储（类型不做运行时校验）", () => {
      // TypeScript 类型在运行时不强制，测试验证存储层不崩溃
      setSettingJSON("codem-env-config", {
        customOperations: [{ name: "No ID", command: "echo test" }],
      });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.customOperations).toHaveLength(1);
      expect(result.customOperations![0].id).toBeUndefined();
    });

    it("F5: customOperation command 为空 — 仍可存储", () => {
      setSettingJSON("codem-env-config", {
        customOperations: [{ id: "empty", name: "空命令", command: "" }],
      });
      const result = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);
      expect(result.customOperations![0].command).toBe("");
    });

    it("F6: 多次快速切换配置 — 最后写入的值生效", () => {
      for (let i = 0; i < 10; i++) {
        setSettingJSON("codem-git-config", { branchPrefix: `branch-${i}/` });
      }
      const result = getSettingJSON<GitConfig>("codem-git-config", null as any);
      expect(result.branchPrefix).toBe("branch-9/");
    });

    it("F7: Git 和 Env 配置使用不同的 key — 互不干扰", () => {
      setSettingJSON("codem-git-config", { branchPrefix: "git-prefix/" });
      setSettingJSON("codem-env-config", { setupScript: "env-setup" });

      const gc = getSettingJSON<GitConfig>("codem-git-config", null as any);
      const ec = getSettingJSON<EnvironmentConfig>("codem-env-config", null as any);

      expect(gc.branchPrefix).toBe("git-prefix/");
      expect(ec.setupScript).toBe("env-setup");
      // 确保没有交叉污染
      expect((gc as any).setupScript).toBeUndefined();
      expect((ec as any).branchPrefix).toBeUndefined();
    });

    it("F8: 长指令文本 — 不被截断", () => {
      const longInstruction = "A".repeat(5000);
      setSettingJSON("codem-git-config", {
        commitMessageInstructions: longInstruction,
      });
      const gc = getSettingJSON<GitConfig>("codem-git-config", null as any);
      const prompt = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc });
      expect(prompt).toContain(longInstruction);
    });

    it("F9: 路径中含空格 — 环境脚本 cwd 正确传递", async () => {
      setSettingJSON("codem-env-config", { setupScript: "echo hi" });
      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript } = await import("../core/environment/environment-runner");
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "hi",
        stderr: "",
        exitCode: 0,
      });

      await runSetupScript("C:\\My Project\\test dir");
      expect(executeCommand).toHaveBeenCalledWith("echo hi", "C:\\My Project\\test dir");
    });

    it("F10: 路径中含中文 — 环境脚本 cwd 正确传递", async () => {
      setSettingJSON("codem-env-config", { setupScript: "echo 你好" });
      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript } = await import("../core/environment/environment-runner");
      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "你好",
        stderr: "",
        exitCode: 0,
      });

      await runSetupScript("/项目/测试目录");
      expect(executeCommand).toHaveBeenCalledWith("echo 你好", "/项目/测试目录");
    });

    it("F11: ProjectSettings 中 git 和 environment 字段共存 — 类型兼容", () => {
      // 验证 ProjectSettings 接口能同时持有 git 和 environment
      const projectSettings = {
        name: "test-project",
        model: "gpt-4o",
        git: { branchPrefix: "feat/", mergeMethod: "squash" as const },
        environment: { setupScript: "npm install", cleanupScript: "npm run clean" },
      };
      setSettingJSON("codem-project-settings", projectSettings);
      const result = getSettingJSON<any>("codem-project-settings", null);
      expect(result.git.branchPrefix).toBe("feat/");
      expect(result.environment.setupScript).toBe("npm install");
    });

    it("F12: mergeMethod 为无效值 — 存储层不校验，prompt 中不匹配任何描述", () => {
      // 存储层不做枚举校验
      setSettingJSON("codem-git-config", { mergeMethod: "invalid" });
      const gc = getSettingJSON<GitConfig>("codem-git-config", null as any);
      const prompt = buildSystemPrompt({ ...basePromptConfig, gitConfig: gc });
      // 无效值不会匹配 merge/squash/rebase 描述，但规则段仍生成（因为 mergeMethod truthy）
      // 实际上代码用 methodDesc[gc.mergeMethod] 查找，无效值返回 undefined
      // 所以不会 push mergeMethod 相关规则，但如果还有其他规则，段仍出现
      expect(prompt).not.toContain("merge commit");
      expect(prompt).not.toContain("squash and merge");
      expect(prompt).not.toContain("rebase and merge");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // G. 项目切换联动逻辑验证（模拟 App.tsx 的 useEffect）
  // ═══════════════════════════════════════════════════════════
  describe("G. 项目切换联动逻辑", () => {
    it("G1: 模拟项目切换 — 旧项目执行 cleanup，新项目执行 setup", async () => {
      setSettingJSON("codem-env-config", {
        setupScript: "echo SETUP",
        cleanupScript: "echo CLEANUP",
      });

      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript, runCleanupScript } = await import("../core/environment/environment-runner");

      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      // 模拟 App.tsx 中的 prevProjectPathRef 逻辑
      let prevPath: string | null = null;

      // 第一次：从 null 到 /project-a
      const newPath1 = "/project-a";
      if (prevPath !== newPath1) {
        if (prevPath) await runCleanupScript(prevPath);
        if (newPath1) await runSetupScript(newPath1);
        prevPath = newPath1;
      }

      // 第二次：从 /project-a 到 /project-b
      const newPath2 = "/project-b";
      if (prevPath !== newPath2) {
        if (prevPath) await runCleanupScript(prevPath);
        if (newPath2) await runSetupScript(newPath2);
        prevPath = newPath2;
      }

      // 验证调用顺序：setup(A) → cleanup(A) → setup(B)
      expect(executeCommand).toHaveBeenNthCalledWith(1, "echo SETUP", "/project-a");
      expect(executeCommand).toHaveBeenNthCalledWith(2, "echo CLEANUP", "/project-a");
      expect(executeCommand).toHaveBeenNthCalledWith(3, "echo SETUP", "/project-b");
    });

    it("G2: 首次打开项目 — 只执行 setup，不执行 cleanup", async () => {
      setSettingJSON("codem-env-config", {
        setupScript: "echo SETUP",
        cleanupScript: "echo CLEANUP",
      });

      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript, runCleanupScript } = await import("../core/environment/environment-runner");

      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      let prevPath: string | null = null;
      const newPath = "/first-project";

      if (prevPath !== newPath) {
        if (prevPath) await runCleanupScript(prevPath);
        if (newPath) await runSetupScript(newPath);
        prevPath = newPath;
      }

      // 只应该有 1 次调用（setup），cleanup 不应被调用
      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(executeCommand).toHaveBeenCalledWith("echo SETUP", "/first-project");
    });

    it("G3: 切换到 null 项目（关闭项目）— 只执行 cleanup", async () => {
      setSettingJSON("codem-env-config", {
        setupScript: "echo SETUP",
        cleanupScript: "echo CLEANUP",
      });

      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript, runCleanupScript } = await import("../core/environment/environment-runner");

      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      let prevPath: string | null = "/current-project";
      const newPath = null;

      if (prevPath !== newPath) {
        if (prevPath) await runCleanupScript(prevPath);
        if (newPath) await runSetupScript(newPath);
        prevPath = newPath;
      }

      // 只应该有 1 次调用（cleanup），setup 不应被调用
      expect(executeCommand).toHaveBeenCalledTimes(1);
      // timeoutMs is handled internally by Promise.race, not passed to executeCommand
      expect(executeCommand).toHaveBeenCalledWith("echo CLEANUP", "/current-project");
    });

    it("G4: 相同路径不触发脚本 — prevPath === newPath", async () => {
      setSettingJSON("codem-env-config", {
        setupScript: "echo SETUP",
        cleanupScript: "echo CLEANUP",
      });

      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript, runCleanupScript } = await import("../core/environment/environment-runner");

      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      let prevPath: string | null = "/same-project";
      const newPath = "/same-project";

      if (prevPath !== newPath) {
        if (prevPath) await runCleanupScript(prevPath);
        if (newPath) await runSetupScript(newPath);
        prevPath = newPath;
      }

      // 路径相同，不应调用任何脚本
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it("G5: 无环境配置时切换项目 — 不调用 executeCommand", async () => {
      // 不设置任何 env config
      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript, runCleanupScript } = await import("../core/environment/environment-runner");

      vi.mocked(executeCommand).mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      let prevPath: string | null = null;
      const newPath = "/no-config-project";

      if (prevPath !== newPath) {
        if (prevPath) await runCleanupScript(prevPath);
        if (newPath) await runSetupScript(newPath);
        prevPath = newPath;
      }

      // 无配置，runSetupScript 返回 null，不调用 executeCommand
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it("G6: cleanup 脚本失败不影响 setup 执行 — 错误隔离", async () => {
      setSettingJSON("codem-env-config", {
        setupScript: "echo SETUP",
        cleanupScript: "echo CLEANUP",
      });

      const { executeCommand } = await import("../core/file-api");
      const { runSetupScript, runCleanupScript } = await import("../core/environment/environment-runner");

      // cleanup 返回失败
      vi.mocked(executeCommand)
        .mockResolvedValueOnce({ stdout: "", stderr: "cleanup error", exitCode: 1 })
        .mockResolvedValueOnce({ stdout: "setup done", stderr: "", exitCode: 0 });

      const cleanupResult = await runCleanupScript("/old-project");
      const setupResult = await runSetupScript("/new-project");

      expect(cleanupResult!.success).toBe(false);
      expect(setupResult!.success).toBe(true);
      // setup 仍然执行了
      expect(executeCommand).toHaveBeenCalledTimes(2);
    });
  });
});
