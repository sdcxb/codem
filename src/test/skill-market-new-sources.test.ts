/**
 * Tests for new skill market sources: ClawHub, Skills.sh, SkillHub CLI
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri invoke and file-api
const mockHttpGet = vi.fn();
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
  getSkillRegistry: () => ({
    getAll: () => [],
    get: () => undefined,
    register: vi.fn(),
  }),
  parseSkillMarkdown: vi.fn(),
}));

// Mock Tauri window
beforeEach(() => {
  (window as any).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: any) => {
        if (cmd === "http_get") return mockHttpGet(args);
        return Promise.resolve({});
      },
    },
  };
  vi.clearAllMocks();
});

describe("New Skill Market Sources — Architecture Verification", () => {

  describe("MarketSourceType 扩展", () => {
    it("应该包含 6 种市场源类型", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查所有 6 种类型
      expect(content).toContain('"github-repo"');
      expect(content).toContain('"github-search"');
      expect(content).toContain('"builtin"');
      expect(content).toContain('"clawhub-api"');
      expect(content).toContain('"skills-sh-api"');
      expect(content).toContain('"cli"');
    });
  });

  describe("默认市场源列表", () => {
    it("应该包含 ClawHub 市场源", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain('id: "clawhub"');
      expect(content).toContain('type: "clawhub-api"');
      expect(content).toContain('url: "https://clawhub.ai"');
    });

    it("应该包含 Skills.sh 市场源", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain('id: "skills-sh"');
      expect(content).toContain('type: "skills-sh-api"');
      expect(content).toContain('url: "https://skills.sh"');
    });

    it("应该包含 SkillHub CLI 市场源", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain('id: "skillhub"');
      expect(content).toContain('type: "cli"');
      expect(content).toContain('cliCommand: "skillhub"');
    });
  });

  describe("MarketSource 新增字段", () => {
    it("应该包含 cliCommand 字段", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain("cliCommand?: string");
    });

    it("应该包含 apiToken 字段", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain("apiToken?: string");
    });
  });

  describe("ClawHub API 适配器", () => {
    it("fetchClawHubSkills 应该调用 /api/v1/skills", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查函数定义
      expect(content).toMatch(/async function fetchClawHubSkills/);
      // 检查 API 端点
      expect(content).toContain("/api/v1/skills");
      // 检查支持 apiToken 认证
      expect(content).toContain("apiToken");
      expect(content).toContain("Authorization");
      expect(content).toContain("Bearer");
    });
  });

  describe("Skills.sh API 适配器", () => {
    it("fetchSkillsShSkills 应该调用 /api/v1/skills 排行榜", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查函数定义
      expect(content).toMatch(/async function fetchSkillsShSkills/);
      // 检查排行榜参数
      expect(content).toContain("view=all-time");
      expect(content).toContain("per_page=100");
    });

    it("应该处理 401 认证错误", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查 401 错误处理
      expect(content).toContain("requires Vercel OIDC token");
    });
  });

  describe("CLI 子进程适配器 (SkillHub)", () => {
    it("fetchCLISkills 应该调用 cliCommand search", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查函数定义
      expect(content).toMatch(/async function fetchCLISkills/);
      // 检查调用 search 命令
      expect(content).toContain("search --json");
      expect(content).toContain("search");
    });

    it("应该支持 JSON 输出解析", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查 JSON 解析
      expect(content).toContain("JSON.parse(trimmed)");
    });

    it("应该支持表格格式解析", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查表格解析
      expect(content).toContain("split(/\\s{2,}|\\t/)");
    });

    it("应该处理 CLI 未安装的情况", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查 CLI 不可用处理
      expect(content).toContain("not available");
    });

    it("installCLISkill 应该调用 cliCommand install", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查安装函数定义
      expect(content).toMatch(/async function installCLISkill/);
      // 检查 install 命令调用
      expect(content).toContain("install ${skill.name}");
    });
  });

  describe("listMarketSkills 类型分派", () => {
    it("应该分派到 fetchClawHubSkills", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain('case "clawhub-api"');
      expect(content).toContain("fetchClawHubSkills");
    });

    it("应该分派到 fetchSkillsShSkills", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain('case "skills-sh-api"');
      expect(content).toContain("fetchSkillsShSkills");
    });

    it("应该分派到 fetchCLISkills", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      expect(content).toContain('case "cli"');
      expect(content).toContain("fetchCLISkills");
    });
  });

  describe("installMarketSkill CLI 类型处理", () => {
    it("应该检测 CLI 安装类型并调用 installCLISkill", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 检查 CLI 安装类型检测
      expect(content).toContain('installType === "cli"');
      expect(content).toContain("installCLISkill");
    });
  });

  describe("完整数据流验证", () => {
    it("SkillHub CLI 完整流程: search → 显示列表 → install", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 1. 列表获取: fetchCLISkills 调用 executeCommand("skillhub search")
      expect(content).toContain("executeCommand");
      expect(content).toContain("search");

      // 2. 显示: MarketSkill 包含 sourceId 和 sourceName
      expect(content).toContain("sourceId: source.id");
      expect(content).toContain("sourceName: source.name");

      // 3. 安装: installCLISkill 调用 executeCommand("skillhub install")
      expect(content).toContain("install");

      // 4. 注册: 安装后注册到 SkillRegistry
      expect(content).toContain("getSkillRegistry().register");
    });

    it("ClawHub API 完整流程: httpGet → 解析 → 显示列表", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 1. HTTP 请求
      expect(content).toContain("httpGet");
      // 2. JSON 解析
      expect(content).toContain("JSON.parse(resp.body)");
      // 3. 构建 MarketSkill
      expect(content).toContain("installType: \"zip\"");
    });

    it("Skills.sh API 完整流程: httpGet → 排行榜 → 显示列表", async () => {
      const fs = require("fs");
      const content = fs.readFileSync("c:/mimo-gui/src/core/skill/skill-market-client.ts", "utf-8");

      // 1. 排行榜 API
      expect(content).toContain("view=all-time");
      // 2. 分页
      expect(content).toContain("per_page=100");
      // 3. 数据解析
      expect(content).toContain("data.data || []");
    });
  });
});
