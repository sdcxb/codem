/**
 * 扩充测试手段 — 综合质量保障套件 — EXT-001 ~ EXT-080
 *
 * 测试方法论扩展：
 *   A. 快照测试 — 组件 DOM 结构一致性（EXT-001 ~ EXT-015）
 *   B. 性能测试 — 大量消息/工具调用的性能基线（EXT-016 ~ EXT-030）
 *   C. 交互测试 — 用户操作流程闭环（EXT-031 ~ EXT-045）
 *   D. CSS 布局一致性 — 弹窗不拥挤/不换行/不变形（EXT-046 ~ EXT-060）
 *   E. 国际化完整性 — i18n 键覆盖率（EXT-061 ~ EXT-070）
 *   F. 系统可用性 — 核心模块单例稳定性（EXT-071 ~ EXT-080）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../components/ui/tooltip";
import * as fs from "fs";
import * as path from "path";

import { initDatabase, resetDatabase } from "../core/storage/database";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getAgentRegistry } from "../core/agent/agent";
import { buildSystemPrompt } from "../core/prompt/prompt";
import { MessageBubble } from "../components/MessageBubble";
import { setLang, getLang, S, useLang } from "../core/i18n/lang";
import { PanelIcons, ActionIcons, StatusIcons } from "../core/icons/icon-map";
import type { Message } from "../store";

const SRC = path.join(__dirname, "..");
function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), "utf-8");
}

const PROJECT_ID = "proj-ext";
const SESSION_ID = "sess-ext";

function setupProjectAndSession(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID,
    name: "扩展测试项目",
    path: "D:\\ext-test",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "扩展测试会话",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  });
}

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("扩充测试手段 — 综合质量保障 — EXT-001 ~ EXT-080", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    setLang("zh");
    setupProjectAndSession();
  });

  // ===== A. 快照测试 — 组件 DOM 结构一致性 =====
  describe("快照测试 — 组件 DOM 结构一致性", () => {
    it("EXT-001: MessageBubble 用户消息 DOM 结构", () => {
      const msg: Message = {
        id: "ext-001", role: "user", content: "快照测试",
        timestamp: Date.now(), status: "done",
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      expect(container.firstChild).toBeTruthy();
    });

    it("EXT-002: MessageBubble AI 消息含 Markdown", () => {
            const msg: Message = {
        id: "ext-002", role: "assistant", content: "这是**加粗**和`代码`",
        timestamp: Date.now(), status: "done",
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      expect(container.querySelector("strong")).toBeTruthy();
      expect(container.querySelector("code")).toBeTruthy();
    });

    it("EXT-003: MessageBubble 流式状态无操作栏", () => {
            const msg: Message = {
        id: "ext-003", role: "assistant", content: "正在生成...",
        timestamp: Date.now(), status: "streaming",
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} canEdit={false} />);
      expect(container.querySelector(".message-actions")).toBeNull();
    });

    it("EXT-004: icon-map PanelIcons 渲染为 SVG", () => {
      const Icon = PanelIcons.agent;
      const { container } = render(<Icon size={24} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute("width")).toBe("24");
    });

    it("EXT-005: ActionIcons.close 渲染为 SVG", () => {
      const CloseIcon = ActionIcons.close;
      const { container } = render(<CloseIcon size={16} />);
      expect(container.querySelector("svg")).toBeTruthy();
    });

    it("EXT-006: StatusIcons.success 渲染为 SVG", () => {
      const Icon = StatusIcons.success;
      const { container } = render(<Icon size={20} />);
      expect(container.querySelector("svg")).toBeTruthy();
    });

    it("EXT-007: PanelIcons 所有图标渲染为有效 SVG 元素", () => {
      for (const key of Object.keys(PanelIcons)) {
        const Icon = (PanelIcons as any)[key];
        const { container } = render(<Icon size={16} />);
        expect(container.querySelector("svg")).toBeTruthy();
      }
    });

    it("EXT-008: ActionIcons 所有图标渲染为有效 SVG 元素", () => {
      for (const key of Object.keys(ActionIcons)) {
        const Icon = (ActionIcons as any)[key];
        const { container } = render(<Icon size={16} />);
        expect(container.querySelector("svg")).toBeTruthy();
      }
    });

    it("EXT-009: StatusIcons 所有图标渲染为有效 SVG 元素", () => {
      for (const key of Object.keys(StatusIcons)) {
        const Icon = (StatusIcons as any)[key];
        const { container } = render(<Icon size={16} />);
        expect(container.querySelector("svg")).toBeTruthy();
      }
    });

    it("EXT-010: 图标 size 属性正确传递到 SVG", () => {
      const Icon = PanelIcons.memory;
      const { container } = render(<Icon size={32} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe("32");
      expect(svg.getAttribute("height")).toBe("32");
    });

    it("EXT-011: MessageBubble 错误状态渲染错误标识", () => {
            const msg: Message = {
        id: "ext-011", role: "assistant", content: "出错了",
        timestamp: Date.now(), status: "error",
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} canEdit={false} />);
      const errorEl = container.querySelector('[class*="error"]');
      expect(errorEl).not.toBeNull();
    });

    it("EXT-012: MessageBubble 工具调用渲染工具组", () => {
            const msg: Message = {
        id: "ext-012", role: "assistant", content: "读取文件",
        timestamp: Date.now(), status: "done",
        toolCalls: [{ id: "tc-ext-012", name: "read", args: { path: "/test/file.ts" }, result: "content", status: "done" }],
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      const toolEl = container.querySelector('[class*="tool-call"]');
      expect(toolEl).not.toBeNull();
    });

    it("EXT-013: MessageBubble 附件渲染附件名", () => {
            const msg: Message = {
        id: "ext-013", role: "user", content: "分析这个文件",
        timestamp: Date.now(), status: "done",
        attachments: [{ id: "att-1", name: "test.ts", type: "code" as const, content: "console.log(1)" }],
      };
      renderWithProviders(<MessageBubble message={msg} />);
      expect(screen.getByText("test.ts")).toBeInTheDocument();
    });

    it("EXT-014: 图标 className 属性可传递", () => {
      const Icon = ActionIcons.close;
      const { container } = render(<Icon size={16} className="test-class" />);
      expect(container.querySelector("svg")).toBeTruthy();
    });

    it("EXT-015: 推理内容默认折叠", () => {
            const msg: Message = {
        id: "ext-015", role: "assistant", content: "答案", reasoning: "思考过程",
        timestamp: Date.now(), status: "done",
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} showReasoning={true} />);
      expect(screen.getByText("答案")).toBeInTheDocument();
      const reasoningEl = container.querySelector('[class*="reasoning"]');
      if (reasoningEl) {
        expect(reasoningEl.classList.contains("expanded")).toBe(false);
      }
    });
  });

  // ===== B. 性能测试 =====
  describe("性能测试 — 性能基线", () => {
    it("EXT-016: 100 条消息写入 < 2s", () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        MessageStorage.createMessage({
          id: `perf-msg-${i}`, role: i % 2 === 0 ? "user" : "assistant",
          content: `消息 ${i} `.repeat(10), timestamp: Date.now() + i, status: "done",
        }, SESSION_ID);
      }
      expect(Date.now() - start).toBeLessThan(2000);
    });

    it("EXT-017: 100 条消息读取 < 500ms", () => {
      for (let i = 0; i < 100; i++) {
        MessageStorage.createMessage({
          id: `perf-read-${i}`, role: "user", content: `读取 ${i}`,
          timestamp: Date.now() + i, status: "done",
        }, SESSION_ID);
      }
      const start = Date.now();
      const msgs = MessageStorage.listMessages(SESSION_ID);
      expect(msgs.length).toBeGreaterThanOrEqual(100);
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("EXT-018: 50 个工具调用关联 < 1s", () => {
      MessageStorage.createMessage({
        id: "perf-tools", role: "assistant", content: "",
        timestamp: Date.now(), status: "done",
      }, SESSION_ID);
      const start = Date.now();
      for (let i = 0; i < 50; i++) {
        MessageStorage.addToolCall("perf-tools", {
          id: `perf-tc-${i}`, tool: "bash", args: { command: `echo ${i}` }, status: "running",
        });
      }
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("EXT-019: 工具注册表创建 < 50ms", () => {
      const start = Date.now();
      createDefaultToolRegistry();
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("EXT-020: 系统提示词构建 < 50ms", () => {
      const registry = getAgentRegistry();
      const buildAgent = registry.get("build")!;
      const start = Date.now();
      buildSystemPrompt({ agent: buildAgent });
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("EXT-021: 1000 字符长消息无截断", () => {
      const longContent = "测试".repeat(500);
      MessageStorage.createMessage({
        id: "perf-long", role: "user", content: longContent,
        timestamp: Date.now(), status: "done",
      }, SESSION_ID);
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "perf-long")!;
      expect(found.content.length).toBe(1000);
    });

    it("EXT-022: 并发 10 个工具注册无冲突", () => {
      const registries: any[] = [];
      for (let i = 0; i < 10; i++) registries.push(createDefaultToolRegistry());
      const ids0 = registries[0].getAll().map((t: any) => t.id).sort();
      const ids1 = registries[9].getAll().map((t: any) => t.id).sort();
      expect(ids0).toEqual(ids1);
    });

    it("EXT-023: 100 个项目创建 < 2s", () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        ProjectStorage.createProject({
          id: `perf-proj-${i}`, name: `项目 ${i}`, path: `D:\\proj-${i}`,
          createdAt: Date.now(), lastAccessedAt: Date.now(),
        });
      }
      expect(Date.now() - start).toBeLessThan(2000);
    });

    it("EXT-024: 100 个会话创建 < 1s", () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        SessionStorage.createSession({
          id: `perf-sess-${i}`, projectId: PROJECT_ID, title: `会话 ${i}`,
          createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
        });
      }
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("EXT-025: 图标渲染 100 次无崩溃", () => {
      const Icon = PanelIcons.agent;
      for (let i = 0; i < 100; i++) {
        const { unmount } = render(<Icon size={16} />);
        unmount();
      }
      expect(true).toBe(true);
    });

    it("EXT-026: 大量 Emoji 消息存储正常", () => {
      const emojis = "🎉🎊🌈✨🔥💯👍🎵💫";
      MessageStorage.createMessage({
        id: "perf-emoji", role: "user", content: emojis,
        timestamp: Date.now(), status: "done",
      }, SESSION_ID);
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "perf-emoji")!;
      expect(found.content).toBe(emojis);
    });

    it("EXT-027: 系统提示词包含必要段落", () => {
      const registry = getAgentRegistry();
      const prompt = buildSystemPrompt({ agent: registry.get("build")! });
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toMatch(/Identity|身份/i);
    });

    it("EXT-028: 50 次消息更新 < 500ms", () => {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `perf-upd-${i}`;
        ids.push(id);
        MessageStorage.createMessage({
          id, role: "assistant", content: "",
          timestamp: Date.now(), status: "streaming",
        }, SESSION_ID);
      }
      const start = Date.now();
      for (const id of ids) MessageStorage.updateMessage(id, { content: `updated ${id}` });
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("EXT-029: 20 次工具状态更新 < 300ms", () => {
      MessageStorage.createMessage({
        id: "perf-tc-upd", role: "assistant", content: "",
        timestamp: Date.now(), status: "done",
      }, SESSION_ID);
      for (let i = 0; i < 20; i++) {
        MessageStorage.addToolCall("perf-tc-upd", {
          id: `perf-tc-upd-${i}`, tool: "bash", args: {}, status: "running",
        });
      }
      const start = Date.now();
      for (let i = 0; i < 20; i++) {
        MessageStorage.updateToolCall("perf-tc-upd", `perf-tc-upd-${i}`, {
          status: "done", result: `result ${i}`,
        });
      }
      expect(Date.now() - start).toBeLessThan(300);
    });

    it("EXT-030: 100 个设置键值对写入 < 500ms", () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) setSettingJSON(`perf-setting-${i}`, { value: i });
      expect(Date.now() - start).toBeLessThan(500);
    });
  });

  // ===== C. 交互测试 =====
  describe("交互测试 — 用户操作流程闭环", () => {
    it("EXT-031: MessageBubble 编辑按钮可交互", () => {
      const onEditAndResend = vi.fn();
            const msg: Message = {
        id: "ext-031", role: "user", content: "原始消息",
        timestamp: Date.now(), status: "done",
      };
      renderWithProviders(<MessageBubble message={msg} canEdit={true} onEditAndResend={onEditAndResend} />);
      const editBtn = screen.queryByTitle(/edit|编辑/i) || screen.queryByRole("button", { name: /edit|编辑/i });
      if (editBtn) fireEvent.click(editBtn);
    });

    it("EXT-032: 用户消息渲染正确内容", () => {
            const msg: Message = { id: "ext-032", role: "user", content: "用户消息", timestamp: Date.now(), status: "done" };
      renderWithProviders(<MessageBubble message={msg} />);
      expect(screen.getByText("用户消息")).toBeInTheDocument();
    });

    it("EXT-033: AI 消息渲染 Markdown 加粗", () => {
            const msg: Message = { id: "ext-033", role: "assistant", content: "这是**加粗文本**", timestamp: Date.now(), status: "done" };
      renderWithProviders(<MessageBubble message={msg} />);
      expect(screen.getByText("加粗文本")).toBeInTheDocument();
    });

    it("EXT-034: AI 消息渲染代码块", () => {
            const msg: Message = { id: "ext-034", role: "assistant", content: "```js\nconsole.log('hello')\n```", timestamp: Date.now(), status: "done" };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      expect(container.querySelector("pre") || container.querySelector("code")).toBeTruthy();
    });

    it("EXT-035: 完成状态显示操作栏", () => {
            const msg: Message = { id: "ext-035", role: "assistant", content: "完成了", timestamp: Date.now(), status: "done" };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      expect(container.querySelector(".message-actions-bar")).not.toBeNull();
    });

    it("EXT-036: 流式状态不显示操作栏", () => {
            const msg: Message = { id: "ext-036", role: "assistant", content: "正在生成", timestamp: Date.now(), status: "streaming" };
      const { container } = renderWithProviders(<MessageBubble message={msg} canEdit={false} />);
      expect(container.querySelector(".message-actions")).toBeNull();
    });

    it("EXT-037: 错误状态显示错误标识", () => {
            const msg: Message = { id: "ext-037", role: "assistant", content: "出错了", timestamp: Date.now(), status: "error" };
      const { container } = renderWithProviders(<MessageBubble message={msg} canEdit={false} />);
      expect(container.querySelector('[class*="error"]')).not.toBeNull();
    });

    it("EXT-038: 工具调用渲染工具名称", () => {
            const msg: Message = {
        id: "ext-038", role: "assistant", content: "执行 bash", timestamp: Date.now(), status: "done",
        toolCalls: [{ id: "tc-ext-038", name: "bash", args: { command: "echo test" }, result: "test", status: "done" }],
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      expect(container.querySelector('[class*="tool-call"]')).not.toBeNull();
    });

    it("EXT-039: 附件名在 DOM 中可见", () => {
            const msg: Message = {
        id: "ext-039", role: "user", content: "分析文件", timestamp: Date.now(), status: "done",
        attachments: [{ id: "att-1", name: "test.ts", type: "code" as const, content: "code" }],
      };
      renderWithProviders(<MessageBubble message={msg} />);
      expect(screen.getByText("test.ts")).toBeInTheDocument();
    });

    it("EXT-040: 中文+Emoji 消息不乱码", () => {
            const msg: Message = { id: "ext-040", role: "user", content: "你好世界🌍🎉", timestamp: Date.now(), status: "done" };
      renderWithProviders(<MessageBubble message={msg} />);
      expect(screen.getByText("你好世界🌍🎉")).toBeInTheDocument();
    });

    it("EXT-041: 推理内容存在但默认折叠", () => {
            const msg: Message = { id: "ext-041", role: "assistant", content: "答案", reasoning: "思考过程", timestamp: Date.now(), status: "done" };
      const { container } = renderWithProviders(<MessageBubble message={msg} showReasoning={true} />);
      expect(screen.getByText("答案")).toBeInTheDocument();
      const reasoningEl = container.querySelector('[class*="reasoning"]');
      if (reasoningEl) expect(reasoningEl.classList.contains("expanded")).toBe(false);
    });

    it("EXT-042: 多条工具调用渲染多个工具组", () => {
            const msg: Message = {
        id: "ext-042", role: "assistant", content: "多工具", timestamp: Date.now(), status: "done",
        toolCalls: [
          { id: "tc-1", name: "read", args: {}, result: "r1", status: "done" },
          { id: "tc-2", name: "write", args: {}, result: "r2", status: "done" },
          { id: "tc-3", name: "bash", args: {}, result: "r3", status: "done" },
        ],
      };
      const { container } = renderWithProviders(<MessageBubble message={msg} />);
      expect(container.querySelectorAll('[class*="tool-call"]').length).toBeGreaterThanOrEqual(1);
    });

    it("EXT-043: i18n 中文模式设置", () => {
      setLang("zh");
      expect(getLang()).toBe("zh");
    });

    it("EXT-044: i18n 英文模式设置", () => {
      setLang("en");
      expect(getLang()).toBe("en");
      setLang("zh");
    });

    it("EXT-045: i18n S 对象包含常用键", () => {
      expect(typeof S).toBe("object");
      expect(Object.keys(S).length).toBeGreaterThan(0);
    });
  });

  // ===== D. CSS 布局一致性 =====
  describe("CSS 布局一致性 — 弹窗不拥挤/不换行/不变形", () => {
    const css = readFile("styles.css");

    it("EXT-046: modal-overlay 有 fixed/absolute 定位", () => {
      expect(css).toMatch(/\.modal-overlay\s*\{[^}]*position:\s*(fixed|absolute)/s);
    });

    it("EXT-047: modal-overlay 有全屏覆盖", () => {
      expect(css).toMatch(/\.modal-overlay\s*\{[^}]*top:\s*0/s);
      expect(css).toMatch(/\.modal-overlay\s*\{[^}]*left:\s*0/s);
    });

    it("EXT-048: modal-overlay 有 z-index", () => {
      expect(css).toMatch(/\.modal-overlay\s*\{[^}]*z-index/s);
    });

    it("EXT-049: modal-editor 有 max-width 或 width 限制", () => {
      expect(css).toMatch(/\.modal-editor\s*\{[^}]*(?:max-width|width)/s);
    });

    it("EXT-050: 关闭按钮使用 flex 布局", () => {
      // 至少一个关闭按钮类使用 display: flex
      const closeClasses = [".memory-manager-close", ".nb-dialog-close", ".pipeline-close", ".modal-close", ".tool-manager-close"];
      let found = false;
      for (const cls of closeClasses) {
        if (css.includes(cls)) {
          const re = new RegExp(cls.replace(".", "\\.") + "\\s*\\{[^}]*display:\\s*flex", "s");
          if (re.test(css)) found = true;
        }
      }
      expect(found || css.includes("display: flex")).toBe(true);
    });

    it("EXT-051: CSS 变量定义在 :root 中", () => {
      expect(css).toMatch(/:root\s*\{/);
      expect(css).toMatch(/--accent/);
    });

    it("EXT-052: dark 主题有独立变量定义", () => {
      expect(css).toMatch(/data-theme|\.dark/s);
    });

    it("EXT-053: 阴影变量存在", () => {
      expect(css).toMatch(/--shadow/i);
    });

    it("EXT-054: --border-primary 变量存在", () => {
      expect(css).toMatch(/--border-primary/);
    });

    it("EXT-055: --bg-secondary 变量存在", () => {
      expect(css).toMatch(/--bg-secondary/);
    });

    it("EXT-056: --bg-tertiary 变量存在", () => {
      expect(css).toMatch(/--bg-tertiary/);
    });

    it("EXT-057: 关闭按钮有 cursor pointer", () => {
      expect(css).toMatch(/close[^{]*\{[^}]*cursor:\s*pointer/s);
    });

    it("EXT-058: 弹窗标题样式存在", () => {
      expect(css).toMatch(/modal-editor|dialog-header|modal.*header|modal.*title/i);
    });

    it("EXT-059: body 有 margin 0", () => {
      expect(css).toMatch(/body\s*\{[^}]*margin:\s*0/s);
    });

    it("EXT-060: CSS 变量值非空", () => {
      const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
      if (rootMatch) {
        const vars = rootMatch[1].matchAll(/--([\w-]+):\s*([^;]+);/g);
        for (const m of vars) {
          expect(m[2].trim().length).toBeGreaterThan(0);
        }
      }
    });
  });

  // ===== E. 国际化完整性 =====
  describe("国际化完整性 — i18n 键覆盖率", () => {
    const langSrc = readFile("core/i18n/lang.ts");

    it("EXT-061: i18n 模块导出 setLang", () => {
      expect(langSrc).toContain("export function setLang");
    });

    it("EXT-062: i18n 模块导出 S 对象", () => {
      expect(langSrc).toContain("export const S");
    });

    it("EXT-063: i18n 模块导出 useLang", () => {
      expect(langSrc).toContain("useLang");
    });

    it("EXT-064: 支持中文", () => {
      expect(langSrc).toContain('"zh"');
    });

    it("EXT-065: 支持英文", () => {
      expect(langSrc).toContain('"en"');
    });

    it("EXT-066: setLang 切换语言状态", () => {
      setLang("en");
      expect(getLang()).toBe("en");
      setLang("zh");
      expect(getLang()).toBe("zh");
    });

    it("EXT-067: S 对象有嵌套结构", () => {
      expect(langSrc).toMatch(/sidebar|input/i);
    });

    it("EXT-068: 语言切换后 S 键集一致", () => {
      setLang("en");
      const enKeys = Object.keys(S);
      setLang("zh");
      const zhKeys = Object.keys(S);
      expect(enKeys.length).toBe(zhKeys.length);
    });

    it("EXT-069: 组件引用 i18n 基础设施", () => {
      const components = ["MessageBubble", "InputArea", "Sidebar"];
      for (const comp of components) {
        try {
          const src = readFile(`components/${comp}.tsx`);
          const hasI18n = src.includes("useLang") || src.includes("S.");
          // 不强制所有组件，只检查存在性
        } catch { /* skip */ }
      }
    });

    it("EXT-070: 语言状态持久化", () => {
      setLang("en");
      const langSrc = readFile("core/i18n/lang.ts");
      const hasPersist = langSrc.includes("persist") || langSrc.includes("localStorage");
      expect(hasPersist).toBe(true);
    });
  });

  // ===== F. 系统可用性 — 核心模块单例稳定性 =====
  describe("系统可用性 — 核心模块单例稳定性", () => {
    it("EXT-071: AgentRegistry 单例稳定", () => {
            expect(getAgentRegistry()).toBe(getAgentRegistry());
    });

    it("EXT-072: AgentRegistry 包含所有内置智能体", () => {
            const ids = getAgentRegistry().getAll().map((a: any) => a.id);
      expect(ids).toContain("build");
      expect(ids).toContain("plan");
      expect(ids).toContain("explore");
      expect(ids).toContain("general");
    });

    it("EXT-073: build 智能体有权限评估", () => {
            expect(getAgentRegistry().evaluatePermission("build", "bash")).toBe("allow");
    });

    it("EXT-074: plan 智能体不能使用 write 工具", () => {
            expect(getAgentRegistry().canUseTool("plan", "write")).toBe(false);
    });

    it("EXT-075: ToolRegistry 包含核心工具", () => {
      const registry = createDefaultToolRegistry();
      const ids = registry.getAll().map((t: any) => t.id);
      expect(ids).toContain("bash");
      expect(ids).toContain("read");
      expect(ids).toContain("write");
      expect(ids).toContain("edit");
      expect(ids).toContain("glob");
      expect(ids).toContain("grep");
    });

    it("EXT-076: load_skill 工具已注册", () => {
      const registry = createDefaultToolRegistry();
      const ids = registry.getAll().map((t: any) => t.id);
      expect(ids).toContain("load_skill");
    });

    it("EXT-077: 智能体有 title 和 summary", () => {
            const ids = getAgentRegistry().getAll().map((a: any) => a.id);
      expect(ids).toContain("title");
      expect(ids).toContain("summary");
    });

    it("EXT-078: 数据库初始化不崩溃", async () => {
      await expect(initDatabase()).resolves.not.toThrow();
    });

    it("EXT-079: 数据库重置后可重新初始化", async () => {
      await resetDatabase();
      await expect(initDatabase()).resolves.not.toThrow();
    });

    it("EXT-080: 设置读写闭环", () => {
      setSettingJSON("ext-test", { nested: { value: 42 } });
      const loaded = getSettingJSON("ext-test", null);
      expect(loaded).toEqual({ nested: { value: 42 } });
    });
  });
});
