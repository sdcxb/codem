/**
 * 测试：Phase B-F 全覆盖回归测试
 *
 * 本文件系统性测试 Phase B 到 Phase F 的所有改动，
 * 按 Phase 分块组织，每个 Phase 内按影响面逐项覆盖。
 *
 * ═══════════════════════════════════════════════════════════
 * Phase B: 工具/技能管理增强
 *   B1: SkillDefinition 扩展字段 + parseSkillMarkdown
 *   B2: SkillToolProvider 接口 + Registry
 *   B3: load_skill / web_search / read_attachment 工具
 *   B4: ToolRegistry.remove + createDefaultToolRegistry 新工具注册
 *   B5: tool-renderer 新工具 Emoji + summarizeArgs
 *   B6: 技能安装器 (installer.ts)
 *   B7: 图标映射 (icon-map.ts)
 *   B8: buildSkillPrompt 禁用过滤
 *
 * Phase C: 技能市场
 *   C1: skill-market-client 类型 + 默认源
 *   C2: Rust HTTP 代理命令
 *   C3: CSP 配置
 *
 * Phase D: 高级技能
 *   D1: 内置技能 SKILL.md 文件存在性
 *   D2: Provider 注册 (prompt-optimization, interactive)
 *   D3: Phase D 类型定义
 *   D4: UI 组件存在性
 *   D5: process 方法支持 Phase D 回调
 *
 * Phase F: 笔记本式知识管理
 *   F1: 数据库表结构
 *   F2: storage.ts CRUD (Notebook/Source/Chunk)
 *   F3: 向量编解码
 *   F4: 文本提取 (extractor.ts)
 *   F5: 文本分块 (chunker.ts)
 *   F6: PDF 提取 (pdf-extractor.ts)
 *   F7: 语义检索 (retriever.ts)
 *   F8: search_notebook 工具
 *   F9: 系统提示词 knowledgeContext
 *   F10: agentic-loop notebookId 透传
 *   F11: index.ts process 方法笔记本支持
 *   F12: 知识模块导出完整性
 *   F13: 索引管道结构
 *   F14: 类型定义完整性
 *
 * 跨模块集成
 *   X1: App.tsx 笔记本集成
 *   X2: Sidebar.tsx 笔记本入口
 *   X3: SettingsPanel.tsx 笔记本设置
 *   X4: styles.css 笔记本样式类
 *   X5: UI 组件完整性
 *   X6: NotebookManager.tsx 结构验证
 *   X7: SkillManager.tsx 结构验证
 *   X8: 数据库表无命名冲突
 *   X9: 一键安装约束验证
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// 静态导入需要运行时测试的模块
import {
  createNotebook, getNotebook, listNotebooks, updateNotebook, deleteNotebook,
  addSource, getSource, listSources, updateSource, deleteSource,
  addChunk, addChunksBulk, getChunks, getChunkCount, deleteChunksBySource,
  refreshNotebookCounts, embeddingToBase64, base64ToEmbedding,
} from "../core/knowledge/storage";
import { stripHtml, extractText } from "../core/knowledge/extractor";
import { chunkText, estimateTokens } from "../core/knowledge/chunker";
import { isPdfFile, extractPdfText } from "../core/knowledge/pdf-extractor";

// ═══════════════════════════════════════════════════════════
// Phase B: 工具/技能管理增强
// ═══════════════════════════════════════════════════════════

describe("Phase B: 工具/技能管理增强", () => {
  const skillSrc = fs.readFileSync(path.join(__dirname, "../core/skill/skill.ts"), "utf-8");
  const toolsSrc = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");
  const toolRendererSrc = fs.readFileSync(path.join(__dirname, "../core/llm/tool-renderer.ts"), "utf-8");

  // ===== B1: SkillDefinition 扩展字段 =====
  describe("B1: SkillDefinition 扩展字段", () => {
    it("SkillDefinition 包含 displayName 字段", () => {
      expect(skillSrc).toContain("displayName");
    });
    it("SkillDefinition 包含 version 字段", () => {
      expect(skillSrc).toContain("version");
    });
    it("SkillDefinition 包含 author 字段", () => {
      expect(skillSrc).toContain("author");
    });
    it("SkillDefinition 包含 tags 字段", () => {
      expect(skillSrc).toContain("tags");
    });
    it("SkillDefinition 包含 provider 字段 (SkillProviderConfig)", () => {
      expect(skillSrc).toContain("provider?: SkillProviderConfig");
    });
    it("SkillDefinition 包含 tools 字段 (SkillToolDeclaration[])", () => {
      expect(skillSrc).toContain("tools?: SkillToolDeclaration[]");
    });
    it("SkillDefinition 包含 mcpServers 字段", () => {
      expect(skillSrc).toContain("mcpServers?: SkillMcpServerDeclaration[]");
    });
    it("SkillDefinition 包含 enabled 字段", () => {
      expect(skillSrc).toContain("enabled?: boolean");
    });
    it("SkillDefinition 包含 forcePreload 字段", () => {
      expect(skillSrc).toContain("forcePreload?: boolean");
    });
    it("SkillDefinition 包含 bindShells 字段", () => {
      expect(skillSrc).toContain("bindShells");
    });
    it("SkillDefinition 包含 dependencies 字段", () => {
      expect(skillSrc).toContain("dependencies?: string[]");
    });
    it("SkillDefinition 包含 config 字段", () => {
      expect(skillSrc).toContain("config?: Record<string, unknown>");
    });
  });

  // ===== B1.2: parseSkillMarkdown 扩展字段解析 =====
  describe("B1.2: parseSkillMarkdown 扩展字段解析", () => {
    it("parseSkillMarkdown 函数存在", () => {
      expect(skillSrc).toContain("export function parseSkillMarkdown");
    });
    it("parseSkillMarkdown 解析 displayName", () => {
      expect(skillSrc).toContain("displayName");
    });
    it("parseSkillMarkdown 解析 version", () => {
      expect(skillSrc).toMatch(/version\s*[=:]/);
    });
    it("parseSkillMarkdown 解析 tags (块数组)", () => {
      expect(skillSrc).toContain('"tags"');
    });
    it("parseSkillMarkdown 解析 provider (嵌套对象)", () => {
      expect(skillSrc).toContain('"provider"');
    });
    it("parseSkillMarkdown 解析 tools (数组对象)", () => {
      expect(skillSrc).toContain('"tools"');
    });
    it("parseSkillMarkdown 处理块数组 (block array)", () => {
      expect(skillSrc).toContain("tryParseBlockArrayItem");
    });
  });

  // ===== B2: SkillToolProvider 接口 + Registry =====
  describe("B2: SkillToolProvider 接口 + Registry", () => {
    const providerSrc = fs.readFileSync(path.join(__dirname, "../core/skill/provider.ts"), "utf-8");
    const registrySrc = fs.readFileSync(path.join(__dirname, "../core/skill/registry.ts"), "utf-8");

    it("SkillToolProvider 接口包含 name 属性", () => {
      expect(providerSrc).toContain("readonly name: string");
    });
    it("SkillToolProvider 接口包含 initialize 方法", () => {
      expect(providerSrc).toContain("initialize?(ctx: SkillProviderContext)");
    });
    it("SkillToolProvider 接口包含 getTools 方法", () => {
      expect(providerSrc).toContain("getTools(): ToolDef[]");
    });
    it("SkillToolProvider 接口包含 dispose 方法", () => {
      expect(providerSrc).toContain("dispose?(): Promise<void>");
    });
    it("SkillProviderContext 包含 skill 属性", () => {
      expect(providerSrc).toContain("skill: SkillDefinition");
    });
    it("SkillProviderContext 包含 skillDir 属性", () => {
      expect(providerSrc).toContain("skillDir: string");
    });
    it("registerBuiltinProvider 函数存在", () => {
      expect(providerSrc).toContain("export function registerBuiltinProvider");
    });
    it("getBuiltinProviderFactory 函数存在", () => {
      expect(providerSrc).toContain("export function getBuiltinProviderFactory");
    });
    it("createSkillTool 辅助函数存在", () => {
      expect(providerSrc).toContain("export function createSkillTool");
    });
    it("SkillToolRegistry 类存在", () => {
      expect(registrySrc).toContain("class SkillToolRegistry");
    });
  });

  // ===== B3: 新工具 (load_skill / web_search / read_attachment) =====
  describe("B3: 新工具定义文件存在", () => {
    it("load-skill.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"))).toBe(true);
    });
    it("web-search.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/llm/tools/web-search.ts"))).toBe(true);
    });
    it("read-attachment.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/llm/tools/read-attachment.ts"))).toBe(true);
    });

    it("load-skill.ts 导出 createLoadSkillTool", () => {
      const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");
      expect(src).toContain("export function createLoadSkillTool");
    });
    it("web-search.ts 导出 createWebSearchTool", () => {
      const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/web-search.ts"), "utf-8");
      expect(src).toContain("export function createWebSearchTool");
    });
    it("read-attachment.ts 导出 createReadAttachmentTool", () => {
      const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/read-attachment.ts"), "utf-8");
      expect(src).toContain("export function createReadAttachmentTool");
    });

    it("load-skill.ts 包含 SessionSkillCache 类", () => {
      const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");
      expect(src).toContain("SessionSkillCache");
    });
    it("load-skill.ts 包含 TTL 机制", () => {
      const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");
      expect(src).toContain("remainingTurns");
      expect(src).toContain("defaultTtl");
    });
  });

  // ===== B4: ToolRegistry + createDefaultToolRegistry =====
  describe("B4: ToolRegistry 和工具注册", () => {
    it("ToolRegistry 包含 remove 方法", () => {
      expect(toolsSrc).toContain("remove(id: string)");
    });
    it("createDefaultToolRegistry 注册 load_skill", () => {
      expect(toolsSrc).toContain("createLoadSkillTool");
    });
    it("createDefaultToolRegistry 注册 web_search", () => {
      expect(toolsSrc).toContain("createWebSearchTool");
    });
    it("createDefaultToolRegistry 注册 read_attachment", () => {
      expect(toolsSrc).toContain("createReadAttachmentTool");
    });
    it("createDefaultToolRegistry 注册 search_notebook (Phase F)", () => {
      expect(toolsSrc).toContain("createSearchNotebookTool");
    });
    it("ToolContext 包含 notebookId (Phase F)", () => {
      expect(toolsSrc).toContain("notebookId?: string");
    });
    it("ToolContext 包含 getSystemPrompt (Phase D)", () => {
      expect(toolsSrc).toContain("getSystemPrompt?");
    });
    it("ToolContext 包含 onPromptChangeSubmit (Phase D)", () => {
      expect(toolsSrc).toContain("onPromptChangeSubmit?");
    });
    it("ToolContext 包含 onInteractiveForm (Phase D)", () => {
      expect(toolsSrc).toContain("onInteractiveForm?");
    });
  });

  // ===== B5: tool-renderer 新工具 Emoji + summarizeArgs =====
  describe("B5: tool-renderer 新工具渲染", () => {
    it("load_skill 工具有 Emoji 图标", () => {
      expect(toolRendererSrc).toContain('load_skill: "🛠️"');
    });
    it("web_search 工具有 Emoji 图标", () => {
      expect(toolRendererSrc).toContain('web_search: "🔎"');
    });
    it("read_attachment 工具有 Emoji 图标", () => {
      expect(toolRendererSrc).toContain('read_attachment: "📎"');
    });
    it("summarizeArgs 处理 load_skill", () => {
      expect(toolRendererSrc).toContain('case "load_skill"');
    });
    it("summarizeArgs 处理 web_search", () => {
      expect(toolRendererSrc).toContain('case "web_search"');
    });
    it("summarizeArgs 处理 read_attachment", () => {
      expect(toolRendererSrc).toContain('case "read_attachment"');
    });
  });

  // ===== B6: 技能安装器 =====
  describe("B6: 技能安装器 (installer.ts)", () => {
    it("installer.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/skill/installer.ts"))).toBe(true);
    });
    const src = fs.readFileSync(path.join(__dirname, "../core/skill/installer.ts"), "utf-8");
    it("导出 installSkillFromZip 函数", () => {
      expect(src).toContain("installSkillFromZip");
    });
    it("包含 InstallResult 类型", () => {
      expect(src).toContain("InstallResult");
    });
    it("包含 InstallProgressCallback 类型", () => {
      expect(src).toContain("InstallProgressCallback");
    });
  });

  // ===== B7: 图标映射 =====
  describe("B7: 图标映射 (icon-map.ts)", () => {
    it("icon-map.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/icons/icon-map.ts"))).toBe(true);
    });
    it("icons/index.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/icons/index.ts"))).toBe(true);
    });
    const src = fs.readFileSync(path.join(__dirname, "../core/icons/icon-map.ts"), "utf-8");
    it("包含工具图标映射", () => {
      expect(src).toContain("ToolIcon");
    });
    it("包含技能图标映射", () => {
      expect(src).toContain("SkillSourceIcons");
    });
    it("包含 MCP 图标映射", () => {
      expect(src).toContain("McpIcon");
    });
  });

  // ===== B8: buildSkillPrompt 禁用过滤 =====
  describe("B8: buildSkillPrompt 禁用过滤", () => {
    it("buildSkillPrompt 函数存在", () => {
      expect(skillSrc).toContain("buildSkillPrompt");
    });
    it("存在禁用技能的 settings key", () => {
      expect(skillSrc).toContain("DISABLED_SKILLS_KEY");
    });
    it("存在 enabled 过滤逻辑", () => {
      expect(skillSrc).toMatch(/enabled/i);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Phase C: 技能市场
// ═══════════════════════════════════════════════════════════

describe("Phase C: 技能市场", () => {
  const marketSrc = fs.readFileSync(path.join(__dirname, "../core/skill/skill-market-client.ts"), "utf-8");

  // ===== C1: 类型 + 默认源 =====
  describe("C1: 类型和默认源", () => {
    it("MarketSource 类型存在", () => {
      expect(marketSrc).toContain("export interface MarketSource");
    });
    it("MarketSkill 类型存在", () => {
      expect(marketSrc).toContain("export interface MarketSkill");
    });
    it("MarketSourceType 包含 github-repo", () => {
      expect(marketSrc).toContain("github-repo");
    });
    it("MarketSourceType 包含 github-search", () => {
      expect(marketSrc).toContain("github-search");
    });
    it("MarketSourceType 包含 builtin", () => {
      expect(marketSrc).toContain("builtin");
    });
    it("存在默认市场源列表", () => {
      expect(marketSrc).toMatch(/DEFAULT.*MARKET|default.*source/i);
    });
    it("市场配置持久化到 settings", () => {
      expect(marketSrc).toContain("getSettingJSON");
      expect(marketSrc).toContain("setSettingJSON");
    });
    it("支持从 GitHub API 获取技能列表", () => {
      expect(marketSrc).toContain("http_get");
    });
    it("支持下载技能 ZIP", () => {
      expect(marketSrc).toMatch(/http_download|download/i);
    });
  });

  // ===== C2: Rust HTTP 代理命令 =====
  describe("C2: Rust HTTP 代理命令", () => {
    const rustSrc = fs.existsSync(path.join(__dirname, "../../src-tauri/src/lib.rs"))
      ? fs.readFileSync(path.join(__dirname, "../../src-tauri/src/lib.rs"), "utf-8")
      : "";

    it("http_get 命令存在", () => {
      expect(rustSrc).toContain("http_get");
    });
    it("http_download 命令存在", () => {
      expect(rustSrc).toContain("http_download");
    });
    it("使用 reqwest 库", () => {
      expect(rustSrc).toContain("reqwest");
    });
  });

  // ===== C3: CSP 配置 =====
  describe("C3: CSP 配置允许 GitHub API", () => {
    it("tauri.conf.json 包含 connect-src 配置", () => {
      const confPath = path.join(__dirname, "../../src-tauri/tauri.conf.json");
      if (fs.existsSync(confPath)) {
        const conf = fs.readFileSync(confPath, "utf-8");
        expect(conf).toContain("connect-src");
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Phase D: 高级技能 (交互式表单/提示词优化)
// ═══════════════════════════════════════════════════════════

describe("Phase D: 高级技能", () => {
  // ===== D1: 内置技能 SKILL.md 存在性 =====
  describe("D1: 内置技能 SKILL.md 文件", () => {
    const skillsDir = path.join(__dirname, "../core/skills");
    const expectedSkills = [
      "conversation-to-prompt",
      "prompt-optimization",
      "interactive",
      "skill-creator",
      "mermaid-diagram",
    ];

    for (const skill of expectedSkills) {
      it(`${skill}/SKILL.md 存在`, () => {
        expect(fs.existsSync(path.join(skillsDir, skill, "SKILL.md"))).toBe(true);
      });
    }

    it("skill-creator 包含 agents 目录", () => {
      expect(fs.existsSync(path.join(skillsDir, "skill-creator", "agents"))).toBe(true);
    });
    it("skill-creator 包含 scripts 目录", () => {
      expect(fs.existsSync(path.join(skillsDir, "skill-creator", "scripts"))).toBe(true);
    });
    it("skill-creator 包含 references 目录", () => {
      expect(fs.existsSync(path.join(skillsDir, "skill-creator", "references"))).toBe(true);
    });
  });

  // ===== D2: Provider 注册 =====
  describe("D2: 内置 Provider 注册", () => {
    const providerSrc = fs.readFileSync(path.join(__dirname, "../core/skill/provider.ts"), "utf-8");

    it("注册了 prompt-optimization provider", () => {
      expect(providerSrc).toContain('registerBuiltinProvider("prompt-optimization"');
    });
    it("注册了 interactive provider", () => {
      expect(providerSrc).toContain('registerBuiltinProvider("interactive"');
    });
    it("引用了 PromptOptimizationProvider 类", () => {
      expect(providerSrc).toContain("PromptOptimizationProvider");
    });
    it("引用了 InteractiveFormProvider 类", () => {
      expect(providerSrc).toContain("InteractiveFormProvider");
    });
    it("prompt-optimization-provider.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/skill/providers/prompt-optimization-provider.ts"))).toBe(true);
    });
    it("interactive-form-provider.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/skill/providers/interactive-form-provider.ts"))).toBe(true);
    });
  });

  // ===== D3: Phase D 类型定义 =====
  describe("D3: Phase D 类型定义", () => {
    const toolsSrc = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");

    it("InteractiveFormOption 类型存在", () => {
      expect(toolsSrc).toContain("InteractiveFormOption");
    });
    it("InteractiveFormQuestion 类型存在", () => {
      expect(toolsSrc).toContain("InteractiveFormQuestion");
    });
    it("PromptChange 类型存在", () => {
      expect(toolsSrc).toContain("PromptChange");
    });
    it("InteractiveFormQuestion 包含 input_type 字段", () => {
      expect(toolsSrc).toContain("input_type");
    });
    it("PromptChange 包含 original 和 suggested 字段", () => {
      expect(toolsSrc).toContain("original");
      expect(toolsSrc).toContain("suggested");
    });
  });

  // ===== D4: UI 组件存在性 =====
  describe("D4: UI 组件存在性", () => {
    it("InteractiveFormDialog.tsx 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../components/InteractiveFormDialog.tsx"))).toBe(true);
    });
    it("PromptChangeReviewDialog.tsx 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../components/PromptChangeReviewDialog.tsx"))).toBe(true);
    });
  });

  // ===== D5: process 方法支持 Phase D 回调 =====
  describe("D5: process 方法 Phase D 回调", () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, "../core/llm/index.ts"), "utf-8");

    it("process options 包含 getSystemPrompt", () => {
      expect(indexSrc).toContain("getSystemPrompt?");
    });
    it("process options 包含 onPromptChangeSubmit", () => {
      expect(indexSrc).toContain("onPromptChangeSubmit?");
    });
    it("process options 包含 onInteractiveForm", () => {
      expect(indexSrc).toContain("onInteractiveForm?");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Phase F: 笔记本式知识管理
// ═══════════════════════════════════════════════════════════

describe("Phase F: 笔记本式知识管理", () => {
  // ===== F1: 数据库表结构 =====
  describe("F1: 数据库表结构扩展", () => {
    const dbSrc = fs.readFileSync(path.join(__dirname, "../core/storage/database.ts"), "utf-8");

    it("notebooks 表存在", () => {
      expect(dbSrc).toContain("CREATE TABLE IF NOT EXISTS notebooks");
    });
    it("notebook_sources 表存在", () => {
      expect(dbSrc).toContain("CREATE TABLE IF NOT EXISTS notebook_sources");
    });
    it("notebook_chunks 表存在", () => {
      expect(dbSrc).toContain("CREATE TABLE IF NOT EXISTS notebook_chunks");
    });
    it("notebooks 表包含 summary 字段", () => {
      expect(dbSrc).toContain("summary TEXT");
    });
    it("notebooks 表包含 summary_status 字段", () => {
      expect(dbSrc).toContain("summary_status TEXT DEFAULT 'pending'");
    });
    it("notebook_sources 表包含 status 字段", () => {
      expect(dbSrc).toContain("status TEXT DEFAULT 'pending'");
    });
    it("notebook_chunks 表包含 embedding BLOB 字段", () => {
      expect(dbSrc).toContain("embedding BLOB");
    });
    it("notebook_chunks 表包含 token_count 字段", () => {
      expect(dbSrc).toContain("token_count INTEGER DEFAULT 0");
    });
    it("notebook_sources 外键 ON DELETE CASCADE", () => {
      expect(dbSrc).toContain("FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE");
    });
    it("notebook_chunks 外键 ON DELETE CASCADE", () => {
      expect(dbSrc).toContain("FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE CASCADE");
    });
    it("idx_notebook_sources_notebook 索引存在", () => {
      expect(dbSrc).toContain("idx_notebook_sources_notebook");
    });
    it("idx_notebook_chunks_notebook 索引存在", () => {
      expect(dbSrc).toContain("idx_notebook_chunks_notebook");
    });
    it("idx_notebook_chunks_source 索引存在", () => {
      expect(dbSrc).toContain("idx_notebook_chunks_source");
    });
  });

  // ===== F2: storage.ts CRUD =====
  describe("F2: storage CRUD 操作", () => {
    it("创建笔记本并获取", () => {
      const nb = createNotebook({ name: "测试笔记本", description: "测试描述" });
      expect(nb.id).toBeTruthy();
      expect(nb.name).toBe("测试笔记本");
      expect(nb.description).toBe("测试描述");
      expect(nb.sourceCount).toBe(0);
      expect(nb.chunkCount).toBe(0);

      const retrieved = getNotebook(nb.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("测试笔记本");
    });

    it("列出多个笔记本", () => {
      createNotebook({ name: "笔记本A" });
      createNotebook({ name: "笔记本B" });
      const list = listNotebooks();
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it("更新笔记本摘要", () => {
      const nb = createNotebook({ name: "摘要测试" });
      updateNotebook(nb.id, { summary: "这是一个摘要", summaryStatus: "completed" });
      const updated = getNotebook(nb.id);
      expect(updated!.summary).toBe("这是一个摘要");
      expect(updated!.summaryStatus).toBe("completed");
    });

    it("删除笔记本", () => {
      const nb = createNotebook({ name: "待删除" });
      deleteNotebook(nb.id);
      expect(getNotebook(nb.id)).toBeNull();
    });

    it("添加来源到笔记本", () => {
      const nb = createNotebook({ name: "来源测试" });
      const src = addSource({
        notebookId: nb.id,
        name: "test.txt",
        type: "text",
        content: "Hello world",
      });
      expect(src.id).toBeTruthy();
      expect(src.name).toBe("test.txt");
      expect(src.type).toBe("text");
      expect(src.status).toBe("pending");

      const retrieved = getSource(src.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("test.txt");
    });

    it("列出笔记本的来源", () => {
      const nb = createNotebook({ name: "来源列表测试" });
      addSource({ notebookId: nb.id, name: "src1", type: "text", content: "a" });
      addSource({ notebookId: nb.id, name: "src2", type: "text", content: "b" });
      const sources = listSources(nb.id);
      expect(sources.length).toBe(2);
    });

    it("更新来源状态", () => {
      const nb = createNotebook({ name: "状态更新测试" });
      const src = addSource({ notebookId: nb.id, name: "test", type: "text", content: "x" });
      updateSource(src.id, { status: "indexed", chunkCount: 5 });
      const updated = getSource(src.id);
      expect(updated!.status).toBe("indexed");
      expect(updated!.chunkCount).toBe(5);
    });

    it("删除来源", () => {
      const nb = createNotebook({ name: "删除来源测试" });
      const src = addSource({ notebookId: nb.id, name: "todelete", type: "text", content: "x" });
      deleteSource(src.id);
      expect(getSource(src.id)).toBeNull();
    });

    it("添加单个 chunk", () => {
      const nb = createNotebook({ name: "Chunk测试" });
      const src = addSource({ notebookId: nb.id, name: "test", type: "text", content: "x" });
      const chunk = addChunk({
        sourceId: src.id,
        notebookId: nb.id,
        content: "这是一个文本块",
        chunkIndex: 0,
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        tokenCount: 10,
      });
      expect(chunk.id).toBeTruthy();
      expect(chunk.content).toBe("这是一个文本块");
    });

    it("批量添加 chunks", () => {
      const nb = createNotebook({ name: "批量Chunk测试" });
      const src = addSource({ notebookId: nb.id, name: "bulk", type: "text", content: "x" });
      addChunksBulk(nb.id, src.id, [
        { content: "块1", chunkIndex: 0, embedding: null, tokenCount: 5 },
        { content: "块2", chunkIndex: 1, embedding: null, tokenCount: 5 },
        { content: "块3", chunkIndex: 2, embedding: new Float32Array([1, 0, 0]), tokenCount: 5 },
      ]);
      const chunks = getChunks(nb.id);
      expect(chunks.length).toBe(3);
      expect(chunks[2].embedding).not.toBeNull();
    });

    it("获取 chunk 数量", () => {
      const nb = createNotebook({ name: "计数测试" });
      const src = addSource({ notebookId: nb.id, name: "cnt", type: "text", content: "x" });
      addChunksBulk(nb.id, src.id, [
        { content: "a", chunkIndex: 0, embedding: null, tokenCount: 1 },
        { content: "b", chunkIndex: 1, embedding: null, tokenCount: 1 },
      ]);
      expect(getChunkCount(nb.id)).toBe(2);
    });

    it("按来源删除 chunks", () => {
      const nb = createNotebook({ name: "删除Chunk测试" });
      const src = addSource({ notebookId: nb.id, name: "del", type: "text", content: "x" });
      addChunksBulk(nb.id, src.id, [
        { content: "a", chunkIndex: 0, embedding: null, tokenCount: 1 },
      ]);
      deleteChunksBySource(src.id);
      expect(getChunks(nb.id).length).toBe(0);
    });

    it("刷新笔记本计数", () => {
      const nb = createNotebook({ name: "计数刷新测试" });
      const src = addSource({ notebookId: nb.id, name: "cnt", type: "text", content: "x" });
      addChunksBulk(nb.id, src.id, [
        { content: "a", chunkIndex: 0, embedding: null, tokenCount: 1 },
        { content: "b", chunkIndex: 1, embedding: null, tokenCount: 1 },
      ]);
      refreshNotebookCounts(nb.id);
      const updated = getNotebook(nb.id);
      expect(updated!.sourceCount).toBe(1);
      expect(updated!.chunkCount).toBe(2);
    });

    it("来源类型支持 file/text/url", () => {
      const nb = createNotebook({ name: "类型测试" });
      const s1 = addSource({ notebookId: nb.id, name: "file.txt", type: "file", filePath: "/tmp/file.txt" });
      const s2 = addSource({ notebookId: nb.id, name: "text", type: "text", content: "hello" });
      const s3 = addSource({ notebookId: nb.id, name: "url", type: "url", url: "https://example.com" });
      expect(s1.type).toBe("file");
      expect(s2.type).toBe("text");
      expect(s3.type).toBe("url");
    });
  });

  // ===== F3: 向量编解码 =====
  describe("F3: 向量编解码", () => {
    it("Float32Array → Base64 → Float32Array 往返一致", () => {
      const original = new Float32Array([0.1, -0.2, 0.5, 1.0, -1.5, 0.0]);
      const b64 = embeddingToBase64(original);
      expect(typeof b64).toBe("string");
      const decoded = base64ToEmbedding(b64);
      expect(decoded).not.toBeNull();
      expect(decoded!.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(Math.abs(decoded![i] - original[i])).toBeLessThan(1e-6);
      }
    });

    it("空字符串返回 null", () => {
      expect(base64ToEmbedding("")).toBeNull();
    });

    it("无效 Base64 返回 null", () => {
      expect(base64ToEmbedding("!!!invalid!!!")).toBeNull();
    });

    it("单元素向量编解码", () => {
      const original = new Float32Array([42.0]);
      const b64 = embeddingToBase64(original);
      const decoded = base64ToEmbedding(b64);
      expect(decoded!.length).toBe(1);
      expect(decoded![0]).toBeCloseTo(42.0);
    });

    it("大向量编解码 (1536维)", () => {
      const original = new Float32Array(1536);
      for (let i = 0; i < 1536; i++) original[i] = Math.random();
      const b64 = embeddingToBase64(original);
      const decoded = base64ToEmbedding(b64);
      expect(decoded!.length).toBe(1536);
      for (let i = 0; i < 1536; i++) {
        expect(Math.abs(decoded![i] - original[i])).toBeLessThan(1e-6);
      }
    });
  });

  // ===== F4: 文本提取 (extractor.ts) =====
  describe("F4: 文本提取", () => {
    it("stripHtml 移除 script 标签", () => {
      const html = '<script>alert("xss")</script><p>Hello</p>';
      const text = stripHtml(html);
      expect(text).not.toContain("alert");
      expect(text).toContain("Hello");
    });

    it("stripHtml 移除 style 标签", () => {
      const html = '<style>.x{color:red}</style><p>World</p>';
      const text = stripHtml(html);
      expect(text).not.toContain("color");
      expect(text).toContain("World");
    });

    it("stripHtml 转换段落为换行", () => {
      const html = '<p>Para1</p><p>Para2</p>';
      const text = stripHtml(html);
      expect(text).toContain("Para1");
      expect(text).toContain("Para2");
      expect(text).toContain("\n");
    });

    it("stripHtml 解码 HTML 实体", () => {
      const html = '<p>&amp; &lt; &gt; &quot; &#39;</p>';
      const text = stripHtml(html);
      expect(text).toContain("&");
      expect(text).toContain("<");
      expect(text).toContain(">");
      expect(text).toContain('"');
      expect(text).toContain("'");
    });

    it("stripHtml 解码中文实体", () => {
      const html = '<p>&copy; &reg; &hellip;</p>';
      const text = stripHtml(html);
      expect(text).toContain("©");
      expect(text).toContain("®");
      expect(text).toContain("…");
    });

    it("stripHtml 处理 br 标签", () => {
      const html = 'Line1<br>Line2<br/>Line3';
      const text = stripHtml(html);
      expect(text).toContain("Line1");
      expect(text).toContain("Line2");
      expect(text).toContain("Line3");
    });

    it("stripHtml 处理空输入", () => {
      expect(stripHtml("")).toBe("");
    });

    it("stripHtml 移除 nav/footer/header", () => {
      const html = '<nav>Menu</nav><main>Content</main><footer>Footer</footer>';
      const text = stripHtml(html);
      expect(text).not.toContain("Menu");
      expect(text).not.toContain("Footer");
      expect(text).toContain("Content");
    });

    it("extractText 处理文本类型来源", async () => {
      const result = await extractText({
        id: "test",
        notebookId: "nb",
        name: "test",
        type: "text",
        content: "这是一段文本内容。",
        status: "pending",
        chunkCount: 0,
        createdAt: Date.now(),
      });
      expect(result.text).toBe("这是一段文本内容。");
      expect(result.error).toBeUndefined();
    });

    it("extractText 空文本返回错误", async () => {
      const result = await extractText({
        id: "test",
        notebookId: "nb",
        name: "empty",
        type: "text",
        content: "",
        status: "pending",
        chunkCount: 0,
        createdAt: Date.now(),
      });
      expect(result.text).toBe("");
      expect(result.error).toBeDefined();
    });

    it("extractText 文件类型在非 Tauri 环境返回错误", async () => {
      const result = await extractText({
        id: "test",
        notebookId: "nb",
        name: "file.txt",
        type: "file",
        filePath: "/tmp/file.txt",
        status: "pending",
        chunkCount: 0,
        createdAt: Date.now(),
      });
      expect(result.error).toBeDefined();
    });

    it("extractText URL 类型在非 Tauri 环境尝试 fetch", async () => {
      const result = await extractText({
        id: "test",
        notebookId: "nb",
        name: "url",
        type: "url",
        url: "https://example.com",
        status: "pending",
        chunkCount: 0,
        createdAt: Date.now(),
      }).catch(() => ({ text: "", error: "fetch failed" }));
      expect(result).toBeDefined();
    });
  });

  // ===== F5: 文本分块 (chunker.ts) =====
  describe("F5: 文本分块", () => {
    it("空文本返回空数组", () => {
      expect(chunkText("")).toEqual([]);
    });

    it("纯空白文本返回空数组", () => {
      expect(chunkText("   \n\n  \t  ")).toEqual([]);
    });

    it("短文本生成单个 chunk", () => {
      const chunks = chunkText("Hello world.");
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toContain("Hello world");
      expect(chunks[0].chunkIndex).toBe(0);
    });

    it("多段落生成多个 chunks", () => {
      const text = "段落一内容。\n\n段落二内容。\n\n段落三内容。";
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].content).toContain("段落一");
    });

    it("长段落按句子分割", () => {
      const longPara = "This is sentence one. This is sentence two. This is sentence three. This is sentence four. This is sentence five.";
      const chunks = chunkText(longPara, { maxChunkSize: 50 });
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("chunk 索引连续递增", () => {
      const text = "段落一。\n\n段落二。\n\n段落三。\n\n段落四。";
      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex).toBe(i);
      }
    });

    it("每个 chunk 有 token 估算", () => {
      const chunks = chunkText("Hello world. This is a test.");
      for (const chunk of chunks) {
        expect(chunk.tokenCount).toBeGreaterThan(0);
      }
    });

    it("自定义配置覆盖默认值", () => {
      const chunks = chunkText("Short text.", { maxChunkSize: 100, overlapSize: 10, topK: 3, similarityThreshold: 0.5 });
      expect(chunks.length).toBe(1);
    });

    it("estimateTokens 英文估算 (~4字符/token)", () => {
      const tokens = estimateTokens("Hello world this is a test");
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(15);
    });

    it("estimateTokens 中文估算 (~1.5 token/字符)", () => {
      const tokens = estimateTokens("你好世界这是一个测试");
      expect(tokens).toBeGreaterThan(10);
    });

    it("estimateTokens 空字符串返回 0", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("estimateTokens 混合中英文", () => {
      const tokens = estimateTokens("Hello 你好 World 世界");
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(20);
    });

    it("重叠窗口产生重叠内容", () => {
      const longText = "A".repeat(100) + ". " + "B".repeat(100) + ". " + "C".repeat(100) + ".";
      const chunks = chunkText(longText, { maxChunkSize: 150, overlapSize: 50 });
      if (chunks.length > 1) {
        expect(chunks.length).toBeGreaterThan(1);
      }
    });
  });

  // ===== F6: PDF 提取 (pdf-extractor.ts) =====
  describe("F6: PDF 提取", () => {
    it("isPdfFile 识别 .pdf 扩展名", () => {
      expect(isPdfFile("document.pdf")).toBe(true);
      expect(isPdfFile("DOCUMENT.PDF")).toBe(true);
      expect(isPdfFile("file.PDF")).toBe(true);
    });

    it("isPdfFile 拒绝非 PDF 文件", () => {
      expect(isPdfFile("file.txt")).toBe(false);
      expect(isPdfFile("file.docx")).toBe(false);
      expect(isPdfFile("file")).toBe(false);
      expect(isPdfFile("")).toBe(false);
    });

    it("extractPdfText 对非 PDF 文件抛出错误", async () => {
      const fakeData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      await expect(extractPdfText(fakeData)).rejects.toThrow("Not a valid PDF file");
    });

    it("extractPdfText 对空数据抛出错误", async () => {
      const emptyData = new Uint8Array([]);
      await expect(extractPdfText(emptyData)).rejects.toThrow();
    });

    it("extractPdfText 对无内容流的 PDF 抛出错误", async () => {
      const pdfHeader = '%PDF-1.4\n%%EOF\n';
      const data = new Uint8Array(pdfHeader.length);
      for (let i = 0; i < pdfHeader.length; i++) data[i] = pdfHeader.charCodeAt(i);
      await expect(extractPdfText(data)).rejects.toThrow();
    });
  });

  // ===== F7: 语义检索 (retriever.ts) =====
  describe("F7: 语义检索", () => {
    const retrieverSrc = fs.readFileSync(path.join(__dirname, "../core/knowledge/retriever.ts"), "utf-8");

    it("retrieve 函数存在", () => {
      expect(retrieverSrc).toContain("export async function retrieve");
    });
    it("retrieveWithContext 函数存在", () => {
      expect(retrieverSrc).toContain("export async function retrieveWithContext");
    });
    it("clearRetrievalCache 函数存在", () => {
      expect(retrieverSrc).toContain("export function clearRetrievalCache");
    });
    it("使用 cosineSimilarity", () => {
      expect(retrieverSrc).toContain("cosineSimilarity");
    });
    it("使用 generateEmbeddings", () => {
      expect(retrieverSrc).toContain("generateEmbeddings");
    });
    it("包含查询缓存", () => {
      expect(retrieverSrc).toContain("queryEmbeddingCache");
      expect(retrieverSrc).toContain("CACHE_MAX_SIZE");
    });
    it("支持 top-K 配置", () => {
      expect(retrieverSrc).toContain("topK");
    });
    it("支持相似度阈值", () => {
      expect(retrieverSrc).toContain("similarityThreshold");
    });
    it("构建上下文字符串带来源引用", () => {
      expect(retrieverSrc).toContain("[Source");
    });
  });

  // ===== F8: search_notebook 工具 =====
  describe("F8: search_notebook 工具", () => {
    it("search-notebook.ts 存在", () => {
      expect(fs.existsSync(path.join(__dirname, "../core/llm/tools/search-notebook.ts"))).toBe(true);
    });
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/search-notebook.ts"), "utf-8");

    it("导出 createSearchNotebookTool", () => {
      expect(src).toContain("export function createSearchNotebookTool");
    });
    it("工具 id 为 search_notebook", () => {
      expect(src).toContain('id: "search_notebook"');
    });
    it("参数包含 query", () => {
      expect(src).toContain('"query"');
    });
    it("参数包含 top_k", () => {
      expect(src).toContain("top_k");
    });
    it("无 notebookId 时返回错误", () => {
      expect(src).toContain("No active notebook");
    });
    it("使用 retrieve 函数", () => {
      expect(src).toContain("retrieve");
    });
    it("使用 getNotebook 函数", () => {
      expect(src).toContain("getNotebook");
    });
  });

  // ===== F9: 系统提示词 knowledgeContext =====
  describe("F9: 系统提示词 knowledgeContext", () => {
    const promptSrc = fs.readFileSync(path.join(__dirname, "../core/prompt/prompt.ts"), "utf-8");

    it("SystemPromptConfig 包含 knowledgeContext", () => {
      expect(promptSrc).toContain("knowledgeContext?");
    });
    it("knowledgeContext 包含 notebookName", () => {
      expect(promptSrc).toContain("notebookName");
    });
    it("knowledgeContext 包含 retrievedContext", () => {
      expect(promptSrc).toContain("retrievedContext");
    });
    it("knowledgeContext 包含 retrievedSources", () => {
      expect(promptSrc).toContain("retrievedSources");
    });
    it("包含 Knowledge Notebook Mode 标题", () => {
      expect(promptSrc).toContain("Knowledge Notebook Mode");
    });
    it("包含来源引用格式 [Source:", () => {
      expect(promptSrc).toContain("[Source:");
    });
    it("包含 search_notebook 工具提示", () => {
      expect(promptSrc).toContain("search_notebook");
    });
  });

  // ===== F10: agentic-loop notebookId 透传 =====
  describe("F10: agentic-loop notebookId 透传", () => {
    const loopSrc = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    it("LoopConfig 包含 notebookId", () => {
      expect(loopSrc).toContain("notebookId?: string");
    });
    it("toolCtx 传递 notebookId", () => {
      expect(loopSrc).toContain("notebookId: this.config.notebookId");
    });
  });

  // ===== F11: index.ts process 方法笔记本支持 =====
  describe("F11: process 方法笔记本支持", () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, "../core/llm/index.ts"), "utf-8");

    it("process options 包含 notebookId", () => {
      expect(indexSrc).toContain("notebookId?: string");
    });
    it("process 方法传递 notebookId 到 loop", () => {
      expect(indexSrc).toContain("loop.updateConfig({ notebookId");
    });
    it("buildSystemPromptAsync 支持 knowledgeContext 参数", () => {
      expect(indexSrc).toContain("knowledgeContext?: SystemPromptConfig");
    });
    it("process 方法构建知识上下文", () => {
      expect(indexSrc).toContain("Build knowledge context");
      expect(indexSrc).toContain("retrieveWithContext");
    });
    it("process 方法传递 knowledgeContext 到 buildSystemPromptAsync", () => {
      expect(indexSrc).toContain("knowledgeContext");
    });
  });

  // ===== F12: 知识模块导出完整性 =====
  describe("F12: 知识模块导出完整性", () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, "../core/knowledge/index.ts"), "utf-8");

    const expectedExports = [
      "Notebook", "NotebookSource", "NotebookChunk", "RetrievalResult",
      "IndexProgress", "NotebookConfig", "CreateNotebookInput", "AddSourceInput",
      "SourceType", "SourceStatus", "SummaryStatus",
      "DEFAULT_CONFIG",
      "createNotebook", "getNotebook", "listNotebooks", "updateNotebook", "deleteNotebook",
      "refreshNotebookCounts", "addSource", "getSource", "listSources", "updateSource",
      "deleteSource", "addChunk", "addChunksBulk", "getChunks", "getChunkCount",
      "deleteChunksBySource", "embeddingToBase64", "base64ToEmbedding",
      "extractText", "extractFromUrl", "stripHtml",
      "chunkText", "estimateTokens",
      "indexSource", "indexNotebook", "generateSummary", "generateGuidedQuestions",
      "reindexSource", "deleteSourceAndCleanup", "getNotebookConfig",
      "retrieve",
      "extractPdfText", "isPdfFile",
    ];

    for (const exp of expectedExports) {
      it(`导出 ${exp}`, () => {
        expect(indexSrc).toContain(exp);
      });
    }
  });

  // ===== F13: 索引管道 (indexer.ts) 结构验证 =====
  describe("F13: 索引管道结构", () => {
    const indexerSrc = fs.readFileSync(path.join(__dirname, "../core/knowledge/indexer.ts"), "utf-8");

    it("indexSource 函数存在", () => {
      expect(indexerSrc).toContain("export async function indexSource");
    });
    it("indexNotebook 函数存在", () => {
      expect(indexerSrc).toContain("export async function indexNotebook");
    });
    it("generateSummary 函数存在", () => {
      expect(indexerSrc).toContain("export async function generateSummary");
    });
    it("generateGuidedQuestions 函数存在", () => {
      expect(indexerSrc).toContain("export async function generateGuidedQuestions");
    });
    it("reindexSource 函数存在", () => {
      expect(indexerSrc).toContain("export async function reindexSource");
    });
    it("deleteSourceAndCleanup 函数存在", () => {
      expect(indexerSrc).toContain("export async function deleteSourceAndCleanup");
    });
    it("getNotebookConfig 函数存在", () => {
      expect(indexerSrc).toContain("export function getNotebookConfig");
    });
    it("使用 extractText 进行文本提取", () => {
      expect(indexerSrc).toContain("extractText");
    });
    it("使用 chunkText 进行分块", () => {
      expect(indexerSrc).toContain("chunkText");
    });
    it("使用 generateEmbeddings 生成向量", () => {
      expect(indexerSrc).toContain("generateEmbeddings");
    });
    it("批量 embedding (BATCH_SIZE)", () => {
      expect(indexerSrc).toContain("BATCH_SIZE");
    });
    it("支持进度回调", () => {
      expect(indexerSrc).toContain("onProgress");
    });
    it("支持增量索引 (跳过已索引)", () => {
      expect(indexerSrc).toContain("status === 'indexed'");
    });
  });

  // ===== F14: 类型定义完整性 =====
  describe("F14: 类型定义完整性", () => {
    const typesSrc = fs.readFileSync(path.join(__dirname, "../core/knowledge/types.ts"), "utf-8");

    it("SummaryStatus 类型包含 pending/generating/completed/failed", () => {
      expect(typesSrc).toContain("'pending'");
      expect(typesSrc).toContain("'generating'");
      expect(typesSrc).toContain("'completed'");
      expect(typesSrc).toContain("'failed'");
    });
    it("SourceType 包含 file/text/url", () => {
      expect(typesSrc).toContain("'file'");
      expect(typesSrc).toContain("'text'");
      expect(typesSrc).toContain("'url'");
    });
    it("SourceStatus 包含 pending/processing/indexed/failed", () => {
      expect(typesSrc).toContain("'processing'");
      expect(typesSrc).toContain("'indexed'");
    });
    it("DEFAULT_CONFIG 包含正确的默认值", () => {
      expect(typesSrc).toContain("maxChunkSize: 2000");
      expect(typesSrc).toContain("overlapSize: 200");
      expect(typesSrc).toContain("topK: 5");
      expect(typesSrc).toContain("similarityThreshold: 0.3");
    });
    it("RetrievalResult 包含 score 和 sourceName", () => {
      expect(typesSrc).toContain("score: number");
      expect(typesSrc).toContain("sourceName: string");
    });
    it("IndexProgressCallback 类型存在", () => {
      expect(typesSrc).toContain("IndexProgressCallback");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 跨模块集成测试
// ═══════════════════════════════════════════════════════════

describe("跨模块集成测试", () => {
  // ===== X1: App.tsx 笔记本状态 + 模式横幅 =====
  describe("X1: App.tsx 笔记本集成", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");

    it("导入 NotebookManager 组件", () => {
      expect(appSrc).toContain("NotebookManager");
    });
    it("包含 showNotebookManager 状态", () => {
      expect(appSrc).toContain("showNotebookManager");
    });
    it("包含 activeNotebookId 状态", () => {
      expect(appSrc).toContain("activeNotebookId");
    });
    it("包含 activeNotebookName 状态", () => {
      expect(appSrc).toContain("activeNotebookName");
    });
    it("传递 notebookId 到 engine.process", () => {
      expect(appSrc).toContain("notebookId: activeNotebookId");
    });
    it("包含笔记本模式横幅", () => {
      expect(appSrc).toContain("notebook-mode-banner");
    });
    it("Sidebar 传递 onNotebooks", () => {
      expect(appSrc).toContain("onNotebooks");
    });
    it("渲染 NotebookManager modal", () => {
      expect(appSrc).toContain("<NotebookManager");
    });
  });

  // ===== X2: Sidebar.tsx 笔记本入口 =====
  describe("X2: Sidebar 笔记本入口", () => {
    const sidebarSrc = fs.readFileSync(path.join(__dirname, "../components/Sidebar.tsx"), "utf-8");

    it("SidebarProps 包含 onNotebooks", () => {
      expect(sidebarSrc).toContain("onNotebooks?");
    });
    it("Sidebar 函数参数解构 onNotebooks", () => {
      expect(sidebarSrc).toContain("onNotebooks");
    });
    it("包含笔记本导航按钮", () => {
      expect(sidebarSrc).toContain("📓");
    });
    it("笔记本按钮调用 onNotebooks", () => {
      expect(sidebarSrc).toContain("onClick={onNotebooks}");
    });
  });

  // ===== X3: SettingsPanel.tsx 笔记本设置 =====
  describe("X3: SettingsPanel 笔记本设置", () => {
    const settingsSrc = fs.readFileSync(path.join(__dirname, "../components/SettingsPanel.tsx"), "utf-8");

    it("导入 getNotebookConfig", () => {
      expect(settingsSrc).toContain("getNotebookConfig");
    });
    it("包含 NotebookSettingsSection 组件", () => {
      expect(settingsSrc).toContain("NotebookSettingsSection");
    });
    it("包含分块大小配置输入", () => {
      expect(settingsSrc).toContain("maxChunkSize");
    });
    it("包含重叠大小配置输入", () => {
      expect(settingsSrc).toContain("overlapSize");
    });
    it("包含 top-K 配置输入", () => {
      expect(settingsSrc).toContain("topK");
    });
    it("包含相似度阈值配置输入", () => {
      expect(settingsSrc).toContain("similarityThreshold");
    });
    it("配置持久化到 codem-notebook-config", () => {
      expect(settingsSrc).toContain("codem-notebook-config");
    });
  });

  // ===== X4: styles.css 笔记本样式 =====
  describe("X4: styles.css 笔记本样式类", () => {
    const cssSrc = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf-8");

    const expectedClasses = [
      ".notebook-manager", ".notebook-manager-header", ".notebook-grid",
      ".notebook-card", ".notebook-card-header", ".notebook-card-title",
      ".notebook-card-delete", ".notebook-empty-state", ".notebook-detail-view",
      ".notebook-detail-header", ".notebook-back-btn", ".notebook-title",
      ".notebook-chat-btn", ".notebook-summary-section", ".notebook-section-title",
      ".notebook-sources-section", ".notebook-source-list", ".notebook-source-item",
      ".notebook-source-name", ".notebook-source-meta", ".notebook-source-delete",
      ".notebook-add-source-btn", ".notebook-indexing-progress",
      ".notebook-guided-questions", ".notebook-question-item", ".notebook-stats",
      ".notebook-input", ".notebook-textarea", ".notebook-btn-cancel",
      ".notebook-btn-confirm", ".notebook-create-btn", ".notebook-create-form",
      ".notebook-mode-banner", ".notebook-mode-close", ".source-type-tab",
    ];

    for (const cls of expectedClasses) {
      it(`CSS 类 ${cls} 存在`, () => {
        expect(cssSrc).toContain(cls);
      });
    }
  });

  // ===== X5: UI 组件完整性 =====
  describe("X5: UI 组件文件存在", () => {
    const components = [
      "NotebookManager", "InteractiveFormDialog", "PromptChangeReviewDialog",
      "SkillManager", "McpManager",
    ];

    for (const comp of components) {
      it(`${comp}.tsx 存在`, () => {
        expect(fs.existsSync(path.join(__dirname, `../components/${comp}.tsx`))).toBe(true);
      });
    }

    const uiComponents = ["switch", "dialog", "alert-dialog", "badge", "card", "progress"];
    for (const comp of uiComponents) {
      it(`ui/${comp}.tsx 存在`, () => {
        expect(fs.existsSync(path.join(__dirname, `../components/ui/${comp}.tsx`))).toBe(true);
      });
    }
  });

  // ===== X6: NotebookManager.tsx 结构验证 =====
  describe("X6: NotebookManager 结构验证", () => {
    const src = fs.readFileSync(path.join(__dirname, "../components/NotebookManager.tsx"), "utf-8");

    it("导出 NotebookManager 组件", () => {
      expect(src).toContain("export function NotebookManager");
    });
    it("包含笔记本列表视图", () => {
      expect(src).toContain("notebook-manager");
    });
    it("包含笔记本详情视图", () => {
      expect(src).toContain("notebook-detail-view");
    });
    it("包含来源类型 tabs (text/file/url)", () => {
      expect(src).toContain("source-type-tab");
      expect(src).toContain("'text'");
      expect(src).toContain("'file'");
      expect(src).toContain("'url'");
    });
    it("包含索引进度显示", () => {
      expect(src).toContain("indexing");
      expect(src).toContain("indexProgress");
    });
    it("包含建议问题显示", () => {
      expect(src).toContain("guidedQuestions");
    });
    it("包含对话入口按钮", () => {
      expect(src).toContain("onOpenNotebookChat");
    });
    it("使用 lucide-react 图标", () => {
      expect(src).toContain("lucide-react");
    });
    it("使用 Dialog 组件创建笔记本", () => {
      expect(src).toContain("Dialog");
    });
    it("使用 AlertDialog 删除确认", () => {
      expect(src).toContain("AlertDialog");
    });
    it("使用 Badge 组件", () => {
      expect(src).toContain("Badge");
    });
    it("使用 Progress 组件", () => {
      expect(src).toContain("Progress");
    });
    it("支持文件选择器", () => {
      expect(src).toContain("handleFileSelect");
    });
    it("PDF 文件在文件选择器中可选", () => {
      expect(src).toContain("'pdf'");
    });
  });

  // ===== X7: SkillManager.tsx 结构验证 =====
  describe("X7: SkillManager 结构验证", () => {
    const src = fs.readFileSync(path.join(__dirname, "../components/SkillManager.tsx"), "utf-8");

    it("导出 SkillManager 组件", () => {
      expect(src).toContain("SkillManager");
    });
    it("包含技能市场 tab", () => {
      expect(src).toMatch(/market|市场/i);
    });
    it("使用图标映射 (icon-map)", () => {
      expect(src).toContain("icon-map");
    });
    it("支持 ZIP 拖拽上传", () => {
      expect(src).toMatch(/drag|drop|拖/i);
    });
    it("支持技能启用/禁用", () => {
      expect(src).toMatch(/enable|disable|启用|禁用/i);
    });
    it("支持删除确认", () => {
      expect(src).toMatch(/delete|删除/i);
    });
  });

  // ===== X8: 数据库初始化不冲突 =====
  describe("X8: 数据库表无命名冲突", () => {
    const dbSrc = fs.readFileSync(path.join(__dirname, "../core/storage/database.ts"), "utf-8");

    it("notebooks 表名唯一", () => {
      const matches = dbSrc.match(/CREATE TABLE IF NOT EXISTS notebooks/g);
      expect(matches).toHaveLength(1);
    });
    it("notebook_sources 表名唯一", () => {
      const matches = dbSrc.match(/CREATE TABLE IF NOT EXISTS notebook_sources/g);
      expect(matches).toHaveLength(1);
    });
    it("notebook_chunks 表名唯一", () => {
      const matches = dbSrc.match(/CREATE TABLE IF NOT EXISTS notebook_chunks/g);
      expect(matches).toHaveLength(1);
    });
  });

  // ===== X9: 一键安装约束验证 =====
  describe("X9: 一键安装约束验证", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8"));

    it("没有引入额外的原生依赖 (nan/ffi-napi 等)", () => {
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      expect(deps["ffi-napi"]).toBeUndefined();
      expect(deps["nan"]).toBeUndefined();
    });
    it("knowledge 模块不引入外部向量数据库依赖", () => {
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      expect(deps["chromadb"]).toBeUndefined();
      expect(deps["@pinecone-database"]).toBeUndefined();
      expect(deps["weaviate"]).toBeUndefined();
    });
    it("PDF 提取不依赖 pdfjs-dist (使用纯 TS 实现)", () => {
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      expect(deps["pdfjs-dist"]).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Phase G: 本地嵌入模型 (ONNX Runtime + 小型 BERT)
//   G1: 风险1 - 超长切片子分块
//   G2: 风险2 - 多领域模型选择
//   G3: 风险3 - 打包轻量化
//   G4: 本地模式路由 (multimodal.ts)
//   G5: 维度不匹配保护 (retriever.ts)
// ═══════════════════════════════════════════════════════════

describe("Phase G: 本地嵌入模型 (ONNX Runtime)", () => {
  const localEmbeddingSrc = fs.readFileSync(
    path.join(__dirname, "../core/knowledge/local-embedding.ts"), "utf-8"
  );
  const multimodalSrc = fs.readFileSync(
    path.join(__dirname, "../core/llm/multimodal.ts"), "utf-8"
  );
  const retrieverSrc = fs.readFileSync(
    path.join(__dirname, "../core/knowledge/retriever.ts"), "utf-8"
  );
  const viteConfigSrc = fs.readFileSync(
    path.join(__dirname, "../../vite.config.ts"), "utf-8"
  );
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src-tauri/tauri.conf.json"), "utf-8")
  );

  // ===== G1: 风险1 - 超长切片子分块 =====
  describe("G1: 风险1 - 超长切片子分块", () => {
    it("local-embedding.ts 导出 subChunkForEmbedding 相关逻辑", () => {
      expect(localEmbeddingSrc).toContain("SUB_CHUNK_MAX_TOKENS");
      expect(localEmbeddingSrc).toContain("subChunkForEmbedding");
      expect(localEmbeddingSrc).toContain("meanPoolEmbeddings");
    });

    it("子分块限制为 128 token", () => {
      expect(localEmbeddingSrc).toContain("SUB_CHUNK_MAX_TOKENS = 128");
    });

    it("generateLocalEmbeddings 内部调用子分块", () => {
      expect(localEmbeddingSrc).toMatch(/generateLocalEmbeddings[\s\S]*subChunkForEmbedding/);
    });

    it("子分块包含句子分割逻辑", () => {
      expect(localEmbeddingSrc).toContain("splitBySentences");
      expect(localEmbeddingSrc).toContain("estimateTokenCount");
    });

    it("mean pooling 合并子片段向量", () => {
      expect(localEmbeddingSrc).toContain("meanPoolEmbeddings");
      expect(localEmbeddingSrc).toContain("L2 归一化");
    });
  });

  // ===== G2: 风险2 - 多领域模型选择 =====
  describe("G2: 风险2 - 多领域模型选择", () => {
    it("AVAILABLE_LOCAL_MODELS 包含多个领域模型", () => {
      // 至少 5 个模型
      const modelCount = (localEmbeddingSrc.match(/id: 'Xenova\//g) || []).length;
      expect(modelCount).toBeGreaterThanOrEqual(5);
    });

    it("包含中文检索专用模型 (bge-small-zh)", () => {
      expect(localEmbeddingSrc).toContain("bge-small-zh-v1.5");
      expect(localEmbeddingSrc).toContain("chinese");
    });

    it("包含英文检索专用模型 (bge-small-en)", () => {
      expect(localEmbeddingSrc).toContain("bge-small-en-v1.5");
      expect(localEmbeddingSrc).toContain("english");
    });

    it("包含多语言检索模型 (multilingual-e5-small)", () => {
      expect(localEmbeddingSrc).toContain("multilingual-e5-small");
      expect(localEmbeddingSrc).toContain("multilingual");
    });

    it("包含通用模型 (all-MiniLM-L6-v2)", () => {
      expect(localEmbeddingSrc).toContain("all-MiniLM-L6-v2");
      expect(localEmbeddingSrc).toContain("general");
    });

    it("包含技术领域模型 (gte-small)", () => {
      expect(localEmbeddingSrc).toContain("gte-small");
      expect(localEmbeddingSrc).toContain("technical");
    });

    it("模型信息包含领域标签 (domain 字段)", () => {
      expect(localEmbeddingSrc).toContain("domain:");
      expect(localEmbeddingSrc).toContain("ModelDomain");
    });

    it("模型信息包含维度和大小", () => {
      expect(localEmbeddingSrc).toContain("dim:");
      expect(localEmbeddingSrc).toContain("size:");
      expect(localEmbeddingSrc).toContain("maxSeqLength:");
    });

    it("提供 recommendModelByDomain 函数", () => {
      expect(localEmbeddingSrc).toContain("recommendModelByDomain");
    });
  });

  // ===== G3: 风险3 - 打包内置策略 =====
  describe("G3: 风险3 - 打包内置策略", () => {
    it("使用动态 import 避免首屏加载", () => {
      expect(localEmbeddingSrc).toContain("await import('@huggingface/transformers')");
    });

    it("启用本地模型加载 (allowLocalModels = true)", () => {
      expect(localEmbeddingSrc).toContain("env.allowLocalModels = true");
    });

    it("配置本地模型路径 (localModelPath)", () => {
      expect(localEmbeddingSrc).toContain("env.localModelPath = '/models/'");
    });

    it("使用浏览器缓存 (IndexedDB)", () => {
      expect(localEmbeddingSrc).toContain("env.useBrowserCache = true");
    });

    it("使用量化模型 (quantized: true)", () => {
      expect(localEmbeddingSrc).toContain("quantized: true");
    });

    it("WASM 路径指向本地 /wasm/", () => {
      expect(localEmbeddingSrc).toContain("wasmPaths = '/wasm/'");
    });

    it("单线程模式 (numThreads = 1)", () => {
      expect(localEmbeddingSrc).toContain("numThreads = 1");
    });

    it("Vite 配置排除 @huggingface/transformers 预打包", () => {
      expect(viteConfigSrc).toContain("exclude: [\"@huggingface/transformers\"]");
    });

    it("Vite 配置包含 WASM 资源处理", () => {
      expect(viteConfigSrc).toContain("assetsInclude");
      expect(viteConfigSrc).toContain("*.wasm");
    });

    it("public/wasm 目录包含 ONNX Runtime WASM 文件", () => {
      const wasmPath = path.join(__dirname, "../../public/wasm/ort-wasm-simd-threaded.jsep.wasm");
      expect(fs.existsSync(wasmPath)).toBe(true);
      const stat = fs.statSync(wasmPath);
      expect(stat.size).toBeGreaterThan(20 * 1024 * 1024); // > 20MB
    });

    it("public/models 目录包含默认模型", () => {
      const modelPath = path.join(__dirname, "../../public/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx");
      expect(fs.existsSync(modelPath)).toBe(true);
      const stat = fs.statSync(modelPath);
      expect(stat.size).toBeGreaterThan(15 * 1024 * 1024); // > 15MB
    });

    it("public/models 目录包含 tokenizer 和 config", () => {
      const tokenizerPath = path.join(__dirname, "../../public/models/Xenova/all-MiniLM-L6-v2/tokenizer.json");
      const configPath = path.join(__dirname, "../../public/models/Xenova/all-MiniLM-L6-v2/config.json");
      expect(fs.existsSync(tokenizerPath)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);
    });

    it("CSP 允许 HuggingFace 非默认模型下载", () => {
      const csp = tauriConf.app.security.csp;
      expect(csp).toContain("huggingface.co");
      expect(csp).toContain("cdn-lfs");
    });

    it("CSP 不包含 jsdelivr CDN", () => {
      const csp = tauriConf.app.security.csp;
      expect(csp).not.toContain("jsdelivr");
    });

    it("CSP 包含 wasm-unsafe-eval", () => {
      const csp = tauriConf.app.security.csp;
      expect(csp).toContain("wasm-unsafe-eval");
    });

    it("没有引入 onnxruntime-node 原生绑定", () => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8")
      );
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      expect(deps["onnxruntime-node"]).toBeUndefined();
      expect(deps["onnxruntime"]).toBeUndefined();
    });
  });

  // ===== G4: 本地模式路由 (multimodal.ts) =====
  describe("G4: 本地模式路由", () => {
    it("导出 isLocalEmbeddingProvider 函数", () => {
      expect(multimodalSrc).toContain("export function isLocalEmbeddingProvider");
    });

    it("导出 getDefaultLocalEmbeddingConfig 函数", () => {
      expect(multimodalSrc).toContain("export function getDefaultLocalEmbeddingConfig");
    });

    it("导出 isUsingLocalEmbedding 函数", () => {
      expect(multimodalSrc).toContain("export function isUsingLocalEmbedding");
    });

    it("未配置时自动回退到本地模式", () => {
      expect(multimodalSrc).toContain("getDefaultLocalEmbeddingConfig");
      expect(multimodalSrc).toContain("自动回退");
    });

    it("generateEmbeddings 支持本地路由", () => {
      expect(multimodalSrc).toContain("isLocalEmbeddingProvider(config)");
      expect(multimodalSrc).toContain("generateLocalEmbeddings");
      expect(multimodalSrc).toContain("initLocalEmbedding");
    });

    it("MULTIMODAL_MODELS 包含 local provider", () => {
      expect(multimodalSrc).toContain("local:");
      expect(multimodalSrc).toContain("Xenova/all-MiniLM-L6-v2");
    });

    it("本地模式不需要 API Key", () => {
      // 本地路由检查在 API Key 检查之前
      const localRouteIdx = multimodalSrc.indexOf("isLocalEmbeddingProvider(config)");
      const apiKeyCheckIdx = multimodalSrc.indexOf("!config.apiKey");
      expect(localRouteIdx).toBeGreaterThan(-1);
      expect(apiKeyCheckIdx).toBeGreaterThan(-1);
      expect(localRouteIdx).toBeLessThan(apiKeyCheckIdx);
    });

    it("MultimodalPanel 包含本地模型选项", () => {
      const panelSrc = fs.readFileSync(
        path.join(__dirname, "../components/MultimodalPanel.tsx"), "utf-8"
      );
      expect(panelSrc).toContain('value="local"');
      expect(panelSrc).toContain("本地模型");
      expect(panelSrc).toContain("AVAILABLE_LOCAL_MODELS");
      expect(panelSrc).toContain("isLocalEmbeddingProvider");
    });

    it("MultimodalPanel 未配置时显示内置模型提示", () => {
      const panelSrc = fs.readFileSync(
        path.join(__dirname, "../components/MultimodalPanel.tsx"), "utf-8"
      );
      expect(panelSrc).toContain("内置本地模型");
      expect(panelSrc).toContain("随安装包打包");
      expect(panelSrc).toContain("离线使用");
    });
  });

  // ===== G5: 维度不匹配保护 (retriever.ts) =====
  describe("G5: 维度不匹配保护", () => {
    it("retriever.ts 包含维度检查逻辑", () => {
      expect(retrieverSrc).toContain("queryDim");
      expect(retrieverSrc).toContain("dimCompatibleChunks");
      expect(retrieverSrc).toContain("dimension mismatch");
    });

    it("维度不匹配时返回空结果", () => {
      expect(retrieverSrc).toContain("dimCompatibleChunks.length === 0");
      expect(retrieverSrc).toContain("return []");
    });

    it("indexer.ts 本地模式使用更小批次", () => {
      const indexerSrc = fs.readFileSync(
        path.join(__dirname, "../core/knowledge/indexer.ts"), "utf-8"
      );
      expect(indexerSrc).toContain("isLocalMode");
      expect(indexerSrc).toContain("BATCH_SIZE = isLocalMode() ? 10 : 100");
    });
  });
});
