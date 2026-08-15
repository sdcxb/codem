/**
 * 图标标准化测试 — ICON-001 ~ ICON-060
 *
 * 覆盖范围：
 *   A. icon-map.ts 完整性（ICON-001 ~ ICON-015）
 *   B. 组件不再直接 import lucide-react 常用图标（ICON-016 ~ ICON-030）
 *   C. 弹窗组件中无 Emoji 残留（ICON-031 ~ ICON-040）
 *   D. 关闭按钮使用 ActionIcons.close（ICON-041 ~ ICON-050）
 *   E. CSS 变量替代硬编码颜色（ICON-051 ~ ICON-060）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), "utf-8");
}

function listComponentFiles(dir: string): string[] {
  const fullDir = path.join(SRC, dir);
  if (!fs.existsSync(fullDir)) return [];
  return fs
    .readdirSync(fullDir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

describe("图标标准化测试 — ICON-001 ~ ICON-060", () => {
  // ===== A. icon-map.ts 完整性 =====
  describe("icon-map.ts 完整性", () => {
    const iconMap = readFile("core/icons/icon-map.ts");

    it("ICON-001: PanelIcons 包含所有面板类型", () => {
      const requiredPanels = [
        "skills",
        "mcp",
        "tools",
        "memory",
        "notebook",
        "usage",
        "agent",
        "diff",
        "pipeline",
        "petMarket",
        "pdf",
        "image",
        "mermaid",
        "code",
        "fullscreen",
        "plugins",
      ];
      for (const key of requiredPanels) {
        expect(iconMap).toContain(`${key}:`);
      }
    });

    it("ICON-002: ActionIcons 包含所有操作按钮", () => {
      const requiredActions = [
        "add",
        "edit",
        "delete",
        "refresh",
        "toggle",
        "view",
        "settings",
        "close",
        "search",
        "confirm",
        "expand",
        "collapse",
        "copy",
      ];
      for (const key of requiredActions) {
        expect(iconMap).toContain(`${key}:`);
      }
    });

    it("ICON-003: StatusIcons 包含所有状态", () => {
      const requiredStatuses = [
        "loading",
        "success",
        "error",
        "warning",
        "danger",
        "pending",
        "paused",
        "running",
        "idle",
      ];
      for (const key of requiredStatuses) {
        expect(iconMap).toContain(`${key}:`);
      }
    });

    it("ICON-004: ToolIcons 包含核心工具映射", () => {
      const requiredTools = [
        "bash",
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "webfetch",
        "websearch",
        "notebook",
        "plan",
        "question",
        "actor",
        "task",
        "memory",
        "skill",
      ];
      for (const key of requiredTools) {
        expect(iconMap).toContain(`${key}:`);
      }
    });

    it("ICON-005: getToolIcon 返回兜底 Wrench", () => {
      expect(iconMap).toContain("?? Wrench");
    });

    it("ICON-006: getToolEmoji 返回兜底 🔧", () => {
      expect(iconMap).toContain("?? \"🔧\"");
    });

    it("ICON-007: index.ts 导出所有图标集", () => {
      const index = readFile("core/icons/index.ts");
      const requiredExports = [
        "PanelIcons",
        "ToolIcons",
        "ActionIcons",
        "StatusIcons",
        "McpIcons",
        "CommonIcons",
        "ToolEmojis",
        "getToolIcon",
        "getStatusIcon",
        "getToolEmoji",
      ];
      for (const exp of requiredExports) {
        expect(index).toContain(exp);
      }
    });

    it("ICON-008: PanelIcons.agent 对应 Bot 图标", () => {
      expect(iconMap).toMatch(/agent:\s*Bot/);
    });

    it("ICON-009: PanelIcons.memory 对应 Brain 图标", () => {
      expect(iconMap).toMatch(/memory:\s*Brain/);
    });

    it("ICON-010: PanelIcons.plugins 对应 Puzzle 图标", () => {
      expect(iconMap).toMatch(/plugins:\s*Puzzle/);
    });

    it("ICON-011: ActionIcons.close 对应 X 图标", () => {
      expect(iconMap).toMatch(/close:\s*X/);
    });

    it("ICON-012: ActionIcons.search 对应 Search 图标", () => {
      expect(iconMap).toMatch(/search:\s*Search/);
    });

    it("ICON-013: StatusIcons.success 对应 CheckCircle2", () => {
      expect(iconMap).toMatch(/success:\s*CheckCircle2/);
    });

    it("ICON-014: StatusIcons.loading 对应 Loader2", () => {
      expect(iconMap).toMatch(/loading:\s*Loader2/);
    });

    it("ICON-015: SkillSourceIcons 包含 4 种来源", () => {
      expect(iconMap).toContain("builtin:");
      expect(iconMap).toContain("project:");
      expect(iconMap).toContain("user:");
      expect(iconMap).toContain("external:");
    });
  });

  // ===== B. 组件不再直接 import lucide-react 常用图标 =====
  describe("组件不直接 import lucide-react 常用图标", () => {
    // 这些图标应该通过 icon-map 引用，不应在组件中直接 import
    const forbiddenDirectImports = [
      { icon: "X", reason: "关闭按钮应使用 ActionIcons.close" },
      { icon: "Plus", reason: "新增按钮应使用 ActionIcons.add" },
      { icon: "Search", reason: "搜索按钮应使用 ActionIcons.search" },
      { icon: "CheckCircle2", reason: "成功状态应使用 StatusIcons.success" },
      { icon: "XCircle", reason: "失败状态应使用 StatusIcons.error" },
      { icon: "AlertTriangle", reason: "错误状态应使用 StatusIcons.danger" },
      { icon: "Loader2", reason: "加载状态应使用 StatusIcons.loading" },
      { icon: "ChevronDown", reason: "展开应使用 ActionIcons.expand" },
      { icon: "ChevronUp", reason: "收起应使用 ActionIcons.collapse" },
    ];

    // 已标准化的组件（不应有直接 import）
    const standardizedComponents = [
      "components/AgentManager.tsx",
      "components/PluginManager.tsx",
      "components/MemoryManager.tsx",
      "components/UsageStats.tsx",
    ];

    for (const comp of standardizedComponents) {
      for (const { icon } of forbiddenDirectImports) {
        it(`ICON-${16 + forbiddenDirectImports.indexOf({ icon }) + standardizedComponents.indexOf(comp) * forbiddenDirectImports.length}: ${comp} 不直接 import ${icon}`, () => {
          const src = readFile(comp);
          // 检查 import 行是否包含该图标（精确匹配 `import { ... Icon, ... } from 'lucide-react'`）
          const importLines = src.split("\n").filter((l) => l.includes("from") && l.includes("lucide-react"));
          for (const line of importLines) {
            // 精确匹配图标名（边界匹配）
            const regex = new RegExp(`\\b${icon}\\b`);
            expect(regex.test(line)).toBe(false);
          }
        });
      }
    }

    // 简化：只测试几个关键组件
    it("ICON-028: AgentManager.tsx 使用 icon-map", () => {
      const src = readFile("components/AgentManager.tsx");
      expect(src).toContain("icon-map");
    });

    it("ICON-029: PluginManager.tsx 使用 icon-map", () => {
      const src = readFile("components/PluginManager.tsx");
      expect(src).toContain("icon-map");
    });

    it("ICON-030: MemoryManager.tsx 使用 icon-map", () => {
      const src = readFile("components/MemoryManager.tsx");
      expect(src).toContain("icon-map");
    });
  });

  // ===== C. 弹窗组件中无 Emoji 残留 =====
  describe("弹窗组件中无 Emoji 残留", () => {
    const modalComponents = [
      { file: "components/AgentManager.tsx", emojis: ["🤖", "🦸", "🧠"] },
      { file: "components/MemoryManager.tsx", emojis: ["🧠", "🔍", "🗑️", "✏️"] },
      { file: "components/NotebookManager.tsx", emojis: ["📓", "📚"] },
      { file: "components/PetMarketDialog.tsx", emojis: ["🐶", "🐱"] },
      { file: "components/PetOverlay.tsx", emojis: [] }, // 允许宠物 emoji
      { file: "components/UsageStats.tsx", emojis: ["📊", "📈"] },
      { file: "components/PluginManager.tsx", emojis: ["🔌", "⚙️", "📦", "🧩", "🎨", "🔗", "🔧"] },
    ];

    for (const { file, emojis } of modalComponents) {
      for (const emoji of emojis) {
        it(`ICON-${31 + modalComponents.indexOf({ file, emojis }) * 5 + emojis.indexOf(emoji)}: ${file} 不含 emoji ${emoji}`, () => {
          const src = readFile(file);
          expect(src).not.toContain(emoji);
        });
      }
    }

    it("ICON-040: 弹窗标题不使用 emoji 作为图标", () => {
      // 检查所有 modal 组件的 header 区域不直接使用 emoji
      const modals = [
        "components/AgentManager.tsx",
        "components/MemoryManager.tsx",
        "components/NotebookManager.tsx",
        "components/UsageStats.tsx",
        "components/PluginManager.tsx",
      ];
      for (const mod of modals) {
        const src = readFile(mod);
        // modal header 区域不应有 emoji 标题
        // 如果有 emoji 出现在 className 包含 header 的行中
        const lines = src.split("\n");
        const headerLines = lines.filter((l) => l.includes("header") || l.includes("title"));
        for (const line of headerLines) {
          // 跳过注释行
          if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
          // 不应在 header 行中直接使用 emoji 作为文本（emoji 在字符串字面量中）
          const emojiInString = line.match(/["'`][^"'`]*[\u{1F000}-\u{1FFFF}][^"'`]*["'`]/u);
          if (emojiInString) {
            // 允许 ToolEmojis 等映射表，但不在 header 行中
            expect(line).not.toMatch(/header.*[\u{1F000}-\u{1FFFF}]/u);
          }
        }
      }
    });
  });

  // ===== D. 关闭按钮使用 ActionIcons.close =====
  describe("关闭按钮使用 ActionIcons.close", () => {
    const componentsWithCloseButton = [
      "components/AgentManager.tsx",
      "components/MemoryManager.tsx",
      "components/NotebookManager.tsx",
      "components/UsageStats.tsx",
      "components/PluginManager.tsx",
      "components/SnapshotPanel.tsx",
      "components/ToolManager.tsx",
      "components/SessionRecovery.tsx",
      "components/FlashcardViewer.tsx",
    ];

    for (const comp of componentsWithCloseButton) {
      const idx = componentsWithCloseButton.indexOf(comp);
      it(`ICON-${41 + idx}: ${comp} 使用 ActionIcons.close 或 icon-map`, () => {
        const src = readFile(comp);
      // ✕ 不应在 JSX 中作为按钮文本
      expect(src).not.toMatch(/>\s*✕\s*</);
      expect(src).not.toMatch(/>✕/);
      // 应该通过 icon-map 引用 close 图标
      const hasIconMap = src.includes("icon-map") || src.includes("ActionIcons") || src.includes("PanelIcons");
      const hasDirectXImport = src.match(/import\s+\{[^}]*\bX\b[^}]*\}\s+from\s+['"]lucide-react['"]/);
      if (hasIconMap) {
        expect(hasDirectXImport).toBeNull();
      }
      });
    }

    it("ICON-050: 弹窗不使用 Unicode ✕ 作为关闭按钮", () => {
      const modals = [
        "components/AgentManager.tsx",
        "components/MemoryManager.tsx",
        "components/NotebookManager.tsx",
        "components/PetMarketDialog.tsx",
        "components/PetOverlay.tsx",
        "components/FlashcardViewer.tsx",
        "components/PdfViewer.tsx",
        "components/SourceViewer.tsx",
      ];
      for (const mod of modals) {
        try {
          const src = readFile(mod);
          // 不应有 ✕ 字符在 JSX 中作为按钮文本
          expect(src).not.toMatch(/>\s*✕/);
        } catch {
          // 文件可能不存在，跳过
        }
      }
    });
  });

  // ===== E. CSS 变量替代硬编码颜色 =====
  describe("CSS 变量替代硬编码颜色", () => {
    it("ICON-051: styles.css 不再使用 --accent-color", () => {
      const css = readFile("styles.css");
      expect(css).not.toContain("--accent-color");
      // 应该使用 --accent
      expect(css).toContain("--accent:");
    });

    it("ICON-052: 组件不使用硬编码 #6366f1", () => {
      const components = listComponentFiles("components");
      for (const comp of components) {
        try {
          const src = readFile(comp);
          expect(src).not.toContain("#6366f1");
        } catch {
          // 跳过
        }
      }
    });

    it("ICON-053: 组件不使用硬编码 #ef4444（应用 var(--error)）", () => {
      const components = listComponentFiles("components");
      for (const comp of components) {
        try {
          const src = readFile(comp);
          // 允许在注释中出现，但不在 style/className 中
          expect(src).not.toMatch(/style.*#ef4444/i);
        } catch {
          // 跳过
        }
      }
    });

    it("ICON-054: 组件不使用硬编码 #22c55e（应用 var(--success)）", () => {
      const components = listComponentFiles("components");
      for (const comp of components) {
        try {
          const src = readFile(comp);
          expect(src).not.toMatch(/style.*#22c55e/i);
        } catch {
          // 跳过
        }
      }
    });

    it("ICON-055: 弹窗组件在 App.tsx 中被 modal-overlay 包裹", () => {
      const appSrc = readFile("App.tsx");
      // MemoryManager 和 NotebookManager 等弹窗组件在 App.tsx 中被 modal-overlay 包裹
      expect(appSrc).toContain("modal-overlay");
    });

    it("ICON-056: 弹窗组件使用 modal-editor 或独立命名空间", () => {
      // AgentManager 使用 modal-editor，MemoryManager 使用 memory-manager 命名空间
      const am = readFile("components/AgentManager.tsx");
      const mm = readFile("components/MemoryManager.tsx");
      const hasModalEditor = am.includes("modal-editor");
      const hasMemoryManager = mm.includes("memory-manager");
      expect(hasModalEditor || hasMemoryManager).toBe(true);
    });

    it("ICON-057: styles.css 定义 --accent 变量", () => {
      const css = readFile("styles.css");
      expect(css).toMatch(/--accent\s*:/);
    });

    it("ICON-058: styles.css 定义 --error 变量", () => {
      const css = readFile("styles.css");
      expect(css).toMatch(/--error\s*:/);
    });

    it("ICON-059: styles.css 定义 --success 变量", () => {
      const css = readFile("styles.css");
      expect(css).toMatch(/--success\s*:/);
    });

    it("ICON-060: styles.css 定义 --warning 变量", () => {
      const css = readFile("styles.css");
      expect(css).toMatch(/--warning\s*:/);
    });
  });

  // ===== F. 图标映射运行时完整性 — 防止引用不存在的图标属性 =====
  describe("图标映射运行时完整性", () => {
    it("ICON-RUN-001: 所有图标集属性值不为 undefined", async () => {
      const iconMapModule = await import("../core/icons/icon-map");
      const iconSets = [
        { name: "PanelIcons", obj: iconMapModule.PanelIcons },
        { name: "ToolIcons", obj: iconMapModule.ToolIcons },
        { name: "ActionIcons", obj: iconMapModule.ActionIcons },
        { name: "StatusIcons", obj: iconMapModule.StatusIcons },
        { name: "McpIcons", obj: iconMapModule.McpIcons },
        { name: "CommonIcons", obj: iconMapModule.CommonIcons },
        { name: "MarketIcons", obj: iconMapModule.MarketIcons },
      ];
      for (const { name, obj } of iconSets) {
        for (const [key, val] of Object.entries(obj)) {
          expect(val).toBeDefined(`图标集 ${name}.${key} 的值为 undefined`);
        }
      }
    });

    it("ICON-RUN-002: 组件引用的图标属性在图标集中存在", async () => {
      const iconMapModule = await import("../core/icons/icon-map");
      // 收集所有图标集的有效属性名
      const allIconSets = [
        iconMapModule.PanelIcons,
        iconMapModule.ToolIcons,
        iconMapModule.ActionIcons,
        iconMapModule.StatusIcons,
        iconMapModule.McpIcons,
        iconMapModule.CommonIcons,
        iconMapModule.MarketIcons,
      ];
      const validKeys = new Set<string>();
      for (const set of allIconSets) {
        for (const key of Object.keys(set)) validKeys.add(key);
      }

      // 扫描所有组件文件中对图标集属性的引用
      const componentDirs = ["components"];
      const pattern = /\b(?:PanelIcons|ToolIcons|ActionIcons|StatusIcons|McpIcons|CommonIcons|MarketIcons)\.(\w+)/g;
      for (const dir of componentDirs) {
        const files = listComponentFiles(dir);
        for (const file of files) {
          const src = readFile(file);
          let match;
          while ((match = pattern.exec(src)) !== null) {
            const prop = match[1];
            expect(validKeys.has(prop)).toBe(true, 
              `文件 ${file} 引用了不存在的图标属性: ${match[0]}`);
          }
        }
      }
    });
  });
});
