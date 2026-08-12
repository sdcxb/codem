/**
 * Tests for Skill Publishing functionality
 *
 * 验证 publishSkillToMarket / listPublishableMarkets / dryRunPublish 的架构完整性
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock file-api
const mockExecuteCommand = vi.fn();
vi.mock("../core/file-api", () => ({
  executeCommand: (...args: any[]) => mockExecuteCommand(...args),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockReturnValue([]),
  setSettingJSON: vi.fn(),
}));

vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({ run: vi.fn(), exec: vi.fn().mockReturnValue([]) }),
}));

vi.mock("../core/skill/skill", () => ({
  getSkillRegistry: () => ({ getAll: () => [], get: () => undefined, register: vi.fn() }),
  parseSkillMarkdown: vi.fn(),
}));

describe("Skill Publishing — Architecture Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PublishConfig 类型", () => {
    it("应该包含所有必要的发布配置字段", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain("export type PublishTarget");
      expect(content).toContain("\"clawhub\"");
      expect(content).toContain("\"github\"");
      expect(content).toContain("\"cli\"");

      expect(content).toContain("export interface PublishConfig");
      expect(content).toContain("target: PublishTarget");
      expect(content).toContain("skillPath: string");
      expect(content).toContain("slug: string");
      expect(content).toContain("displayName: string");
      expect(content).toContain("version: string");
      expect(content).toContain("changelog?");
      expect(content).toContain("tags?");
      expect(content).toContain("githubRepoName?");
      expect(content).toContain("githubPrivate?");
    });
  });

  describe("PublishResult 类型", () => {
    it("应该包含结果字段", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain("export interface PublishResult");
      expect(content).toContain("success: boolean");
      expect(content).toContain("url?");
      expect(content).toContain("publishedId?");
      expect(content).toContain("error?");
      expect(content).toContain("rawOutput?");
    });
  });

  describe("PublishableMarket 类型", () => {
    it("应该包含可发布市场信息字段", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain("export interface PublishableMarket");
      expect(content).toContain("ready: boolean");
      expect(content).toContain("notReadyReason?");
    });
  });

  describe("listPublishableMarkets", () => {
    it("应该检查 ClawHub CLI 安装和登录状态", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain("async function isCLIInstalled");
      expect(content).toContain("async function checkClawHubAuth");
      expect(content).toContain("clawhub whoami");
      expect(content).toContain("export async function listPublishableMarkets");
    });

    it("应该包含 ClawHub 市场", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查 ClawHub 被添加到 markets 列表
      const listSection = content.substring(
        content.indexOf("export async function listPublishableMarkets"),
        content.indexOf("export async function listPublishableMarkets") + 2000,
      );
      expect(listSection).toContain("ClawHub.ai");
      expect(listSection).toContain("target: \"clawhub\"");
    });

    it("应该包含 GitHub 仓库选项", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const listSection = content.substring(
        content.indexOf("export async function listPublishableMarkets"),
        content.indexOf("export async function listPublishableMarkets") + 3000,
      );
      expect(listSection).toContain("GitHub 仓库");
      expect(listSection).toContain("target: \"github\"");
    });

    it("应该检查 CLI 类型市场", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const listSection = content.substring(
        content.indexOf("export async function listPublishableMarkets"),
        content.indexOf("export async function listPublishableMarkets") + 4000,
      );
      // 检查遍历 CLI 类型市场源
      expect(listSection).toContain("source.type === \"cli\"");
    });
  });

  describe("publishToClawHub", () => {
    it("应该调用 clawhub skill publish 命令", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const clawhubSection = content.substring(
        content.indexOf("async function publishToClawHub"),
        content.indexOf("async function publishToGitHub"),
      );

      expect(clawhubSection).toContain("clawhub");
      expect(clawhubSection).toContain("skill");
      expect(clawhubSection).toContain("publish");
      expect(clawhubSection).toContain("--slug");
      expect(clawhubSection).toContain("--name");
      expect(clawhubSection).toContain("--version");
      expect(clawhubSection).toContain("--changelog");
      expect(clawhubSection).toContain("--tags");
    });

    it("应该从输出中提取技能 URL", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const clawhubSection = content.substring(
        content.indexOf("async function publishToClawHub"),
        content.indexOf("async function publishToGitHub"),
      );

      expect(clawhubSection).toContain("urlMatch");
      expect(clawhubSection).toContain("clawhub.ai");
    });
  });

  describe("publishToGitHub", () => {
    it("应该执行 git init + add + commit + gh repo create", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const githubSection = content.substring(
        content.indexOf("async function publishToGitHub"),
        content.indexOf("async function publishToCLI"),
      );

      expect(githubSection).toContain("git init");
      expect(githubSection).toContain("git add -A");
      expect(githubSection).toContain("git commit");
      expect(githubSection).toContain("gh repo create");
      expect(githubSection).toContain("--push");
    });

    it("应该支持公开/私有仓库选项", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const githubSection = content.substring(
        content.indexOf("async function publishToGitHub"),
        content.indexOf("async function publishToCLI"),
      );

      expect(githubSection).toContain("--private");
      expect(githubSection).toContain("--public");
    });
  });

  describe("publishToCLI", () => {
    it("应该尝试 publish 命令并 fallback 到 upload", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const cliSection = content.substring(
        content.indexOf("async function publishToCLI"),
        content.indexOf("export async function publishSkillToMarket"),
      );

      expect(cliSection).toContain("publish");
      expect(cliSection).toContain("upload");
      expect(cliSection).toContain("不支持");
    });
  });

  describe("publishSkillToMarket 统一入口", () => {
    it("应该根据 target 分派到对应的发布函数", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const dispatchSection = content.substring(
        content.indexOf("export async function publishSkillToMarket"),
        content.indexOf("export async function dryRunPublish"),
      );

      expect(dispatchSection).toContain('case "clawhub"');
      expect(dispatchSection).toContain("publishToClawHub");
      expect(dispatchSection).toContain('case "github"');
      expect(dispatchSection).toContain("publishToGitHub");
      expect(dispatchSection).toContain('case "cli"');
      expect(dispatchSection).toContain("publishToCLI");
    });

    it("应该验证必填字段", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const dispatchSection = content.substring(
        content.indexOf("export async function publishSkillToMarket"),
        content.indexOf("export async function dryRunPublish"),
      );

      expect(dispatchSection).toContain("技能路径不能为空");
      expect(dispatchSection).toContain("技能 slug 不能为空");
      expect(dispatchSection).toContain("版本号不能为空");
    });
  });

  describe("dryRunPublish", () => {
    it("应该支持 ClawHub 的 --dry-run", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const dryRunSection = content.substring(
        content.indexOf("export async function dryRunPublish"),
      );

      expect(dryRunSection).toContain("--dry-run");
      expect(dryRunSection).toContain("--json");
    });

    it("非 ClawHub 市场应返回就绪检查", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const dryRunSection = content.substring(
        content.indexOf("export async function dryRunPublish"),
      );

      expect(dryRunSection).toContain("listPublishableMarkets");
      expect(dryRunSection).toContain("不支持 dry-run");
    });
  });

  describe("Re-exports", () => {
    it("应该在 skill/index.ts 中导出发布相关 API", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/index.ts", "utf-8");

      expect(content).toContain("publishSkillToMarket");
      expect(content).toContain("dryRunPublish");
      expect(content).toContain("listPublishableMarkets");
      expect(content).toContain("PublishTarget");
      expect(content).toContain("PublishConfig");
      expect(content).toContain("PublishResult");
      expect(content).toContain("PublishableMarket");
    });
  });

  describe("UI 集成", () => {
    it("SkillManager 应该导入发布 API", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/components/SkillManager.tsx", "utf-8");

      expect(content).toContain("publishSkillToMarket");
      expect(content).toContain("listPublishableMarkets");
      expect(content).toContain("PublishTarget");
      expect(content).toContain("PublishableMarket");
    });

    it("应该有发布状态管理", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/components/SkillManager.tsx", "utf-8");

      expect(content).toContain("publishTarget");
      expect(content).toContain("publishMarkets");
      expect(content).toContain("publishLoading");
      expect(content).toContain("publishResult");
      expect(content).toContain("publishForm");
    });

    it("应该有发布按钮", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/components/SkillManager.tsx", "utf-8");

      expect(content).toContain("发布到市场");
      expect(content).toContain("skill-detail-btn publish");
    });

    it("应该有发布对话框", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/components/SkillManager.tsx", "utf-8");

      expect(content).toContain("Publish Dialog");
      expect(content).toContain("publish-dialog");
      expect(content).toContain("publish-form");
      expect(content).toContain("publish-market-list");
    });

    it("应该有 CSS 样式", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/styles.css", "utf-8");

      expect(content).toContain(".skill-detail-btn.publish");
      expect(content).toContain(".publish-dialog");
      expect(content).toContain(".publish-form");
      expect(content).toContain(".publish-market-item");
      expect(content).toContain(".publish-result");
    });
  });

  describe("完整发布流程验证", () => {
    it("ClawHub 发布流程: 构建命令 → 执行 → 提取URL → 返回结果", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const clawhubSection = content.substring(
        content.indexOf("async function publishToClawHub"),
        content.indexOf("async function publishToGitHub"),
      );

      // 1. 构建命令
      expect(clawhubSection).toContain("parts = [");
      expect(clawhubSection).toContain("executeCommand");
      // 2. 检查 exitCode
      expect(clawhubSection).toContain("exitCode");
      // 3. 提取 URL
      expect(clawhubSection).toContain("urlMatch");
      // 4. 返回结果
      expect(clawhubSection).toContain("success: true");
      expect(clawhubSection).toContain("url");
      expect(clawhubSection).toContain("publishedId");
    });

    it("GitHub 发布流程: git init → add → commit → gh repo create → push", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      const githubSection = content.substring(
        content.indexOf("async function publishToGitHub"),
        content.indexOf("async function publishToCLI"),
      );

      // 按顺序检查
      const initIdx = githubSection.indexOf("git init");
      const addIdx = githubSection.indexOf("git add -A");
      const commitIdx = githubSection.indexOf("git commit");
      const createIdx = githubSection.indexOf("gh repo create");

      expect(initIdx).toBeGreaterThan(-1);
      expect(addIdx).toBeGreaterThan(initIdx);
      expect(commitIdx).toBeGreaterThan(addIdx);
      expect(createIdx).toBeGreaterThan(commitIdx);
    });
  });
});
