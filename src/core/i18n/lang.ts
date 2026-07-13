// ========== Language Manager ==========
// Centralized language management for Codem
// Stores language preference in SQLite settings

import { useState, useEffect } from "react";
import { getSetting, setSetting } from "../storage/settings";

export type Language = "zh" | "en";

let cachedLang: Language | null = null;

/** Get current language setting (cached, defaults to "zh") */
export function getLang(): Language {
  if (cachedLang) return cachedLang;
  try {
    const stored = getSetting("codem-language");
    cachedLang = (stored === "en") ? "en" : "zh";
  } catch {
    cachedLang = "zh";
  }
  return cachedLang;
}

/** Set language and persist to database */
export function setLang(lang: Language): void {
  cachedLang = lang;
  setSetting("codem-language", lang);
  // Dispatch event so React components using useLang() re-render
  window.dispatchEvent(new Event("codem-language-changed"));
  // Update tray menu language (Tauri backend)
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (invoke) invoke("update_tray_language", { lang }).catch(() => {});
  } catch {}
}

/** Check if current language is Chinese */
export function isZh(): boolean {
  return getLang() === "zh";
}

/** Check if current language is English */
export function isEn(): boolean {
  return getLang() === "en";
}

/**
 * React hook that returns the current language and re-renders on change.
 * Use this in components that need to update UI text when language switches.
 */
export function useLang(): Language {
  const [lang, setLangState] = useState<Language>(getLang());
  useEffect(() => {
    const handler = () => setLangState(getLang());
    window.addEventListener("codem-language-changed", handler);
    window.addEventListener("codem-settings-changed", handler);
    return () => {
      window.removeEventListener("codem-language-changed", handler);
      window.removeEventListener("codem-settings-changed", handler);
    };
  }, []);
  return lang;
}

// ========== UI Strings ==========

export const S = {
  // Sidebar
  sidebar: {
    newChat: { zh: "新对话", en: "New Chat" },
    search: { zh: "搜索", en: "Search" },
    mcp: { zh: "MCP", en: "MCP" },
    skills: { zh: "技能", en: "Skills" },
    memory: { zh: "记忆", en: "Memory" },
    settings: { zh: "设置", en: "Settings" },
    projects: { zh: "项目", en: "Projects" },
    addProject: { zh: "新增项目", en: "Add Project" },
    noProjects: { zh: "暂无项目", en: "No projects" },
    noSessions: { zh: "暂无对话", en: "No conversations" },
    toggleTheme: { zh: "切换主题", en: "Toggle theme" },
    moreActions: { zh: "更多操作", en: "More actions" },
    pinProject: { zh: "📌 置顶项目", en: "📌 Pin Project" },
    unpinProject: { zh: "📌 取消置顶", en: "📌 Unpin" },
    fileBrowser: { zh: "📂 文件浏览器", en: "📂 File Browser" },
    removeProject: { zh: "🗑️ 移除项目", en: "🗑️ Remove Project" },
    deleteSession: { zh: "删除对话", en: "Delete Chat" },
    deleteSessionMsg: { zh: "确定删除「", en: 'Delete "' },
    deleteSessionMsgEnd: { zh: "」？", en: '"?' },
    confirmDelete: { zh: "删除", en: "Delete" },
    cancel: { zh: "取消", en: "Cancel" },
  },

  // Settings panel
  settings: {
    title: { zh: "⚙️ 设置", en: "⚙️ Settings" },
    runMode: { zh: "运行模式", en: "Run Mode" },
    apiMode: { zh: "API 模式", en: "API Mode" },
    apiModeDesc: { zh: "配置 API Key，调用大模型 API", en: "Configure API Key to call LLM API" },
    cliMode: { zh: "CLI 模式", en: "CLI Mode" },
    cliModeDesc: { zh: "MiMo 账号登录，使用积分调用", en: "MiMo account login, use credits" },
    model: { zh: "模型", en: "Model" },
    theme: { zh: "主题", en: "Theme" },
    dark: { zh: "深色", en: "Dark" },
    light: { zh: "浅色", en: "Light" },
    language: { zh: "语言 / Language", en: "语言 / Language" },
    fontSize: { zh: "字体大小", en: "Font Size" },
    autoApprove: { zh: "自动批准工具调用", en: "Auto-approve tool calls" },
    closeBehavior: { zh: "关闭窗口时", en: "On Window Close" },
    closeAsk: { zh: "每次询问", en: "Ask every time" },
    closeTray: { zh: "最小化到系统托盘", en: "Minimize to tray" },
    closeQuit: { zh: "直接关闭程序", en: "Quit application" },
    identityConfig: { zh: "身份配置", en: "Identity" },
    callMe: { zh: "叫我什么", en: "Name" },
    whatAmI: { zh: "我是什么", en: "What am I" },
    whatStyle: { zh: "什么风格", en: "Style" },
    myIcon: { zh: "我的标志", en: "My Icon" },
    aboutYou: { zh: "关于你", en: "About You" },
    yourName: { zh: "你的名字", en: "Your Name" },
    callYou: { zh: "想让我怎么叫你", en: "What to call you" },
    yourTimezone: { zh: "你的时区", en: "Your Timezone" },
    apiConfig: { zh: "API 配置", en: "API Configuration" },
    saveRefresh: { zh: "保存并刷新模型", en: "Save & Refresh Models" },
    sessionRecovery: { zh: "🔄 会话恢复", en: "🔄 Session Recovery" },
    usageStats: { zh: "📊 用量统计", en: "📊 Usage Stats" },
    saved: { zh: "✅ 已保存", en: "✅ Saved" },
    saveSettings: { zh: "保存设置", en: "Save Settings" },
  },

  // Close confirm dialog
  closeConfirm: {
    title: { zh: "关闭窗口", en: "Close Window" },
    message: { zh: "您可以最小化到系统托盘继续运行，或直接关闭程序。", en: "You can minimize to system tray or close the application." },
    tray: { zh: "📭 最小化到系统托盘", en: "📭 Minimize to Tray" },
    trayDesc: { zh: "程序在后台继续运行，点击托盘图标恢复", en: "Keep running in background, click tray icon to restore" },
    quit: { zh: "⏹ 关闭程序", en: "⏹ Quit Application" },
    quitDesc: { zh: "完全退出 Codem", en: "Completely exit Codem" },
    remember: { zh: "记住选择，以后不再询问（可在设置中修改）", en: "Remember choice (can be changed in Settings)" },
  },

  // Tool return labels
  tool: {
    subagentStarted: { zh: "子智能体", en: "Sub-agent" },
    startedFor: { zh: "已启动，任务", en: "started for" },
    status: { zh: "状态", en: "Status" },
    summary: { zh: "摘要", en: "Summary" },
    output: { zh: "输出", en: "Output" },
    files: { zh: "文件", en: "Files" },
    none: { zh: "无", en: "none" },
    error: { zh: "错误", en: "Error" },
    managerNotInit: { zh: "错误：子智能体管理器未初始化", en: "Error: Sub-agent manager not initialized" },
    taskNotFound: { zh: "错误：未找到任务", en: "Error: Task not found" },
    taskFailed: { zh: "任务失败", en: "Task failed" },
    taskCancelled: { zh: "错误：任务已取消", en: "Error: Task cancelled" },
  },

  // Subagent prompt sections
  subagent: {
    identityTitle: { zh: "身份", en: "Identity" },
    languageTitle: { zh: "语言规则", en: "Language" },
    workDirTitle: { zh: "工作目录", en: "Working Directory" },
    taskExecTitle: { zh: "任务执行 — 严格按以下步骤操作", en: "Task Execution — FOLLOW THESE STEPS EXACTLY" },
    encodingTitle: { zh: "Windows 中文编码规则（关键）", en: "Windows Chinese Encoding Rules (CRITICAL)" },
    toolResultsMarker: { zh: "[工具结果]", en: "[Tool Results]" },
  },

  // parseTaskResult
  parse: {
    taskCompleted: { zh: "任务已完成", en: "Task completed" },
  },

  // ChatPanel
  chat: {
    hideReasoning: { zh: "隐藏思考过程", en: "Hide reasoning" },
    showReasoning: { zh: "显示思考过程", en: "Show reasoning" },
    agentList: { zh: "智能体工作列表", en: "Agent tasks" },
    snapshot: { zh: "文件快照", en: "File snapshots" },
    contextMonitor: { zh: "上下文监控", en: "Context monitor" },
    loading: { zh: "⏳ 加载中...", en: "⏳ Loading..." },
    loadMore: { zh: "↑ 滚动加载更多历史消息", en: "↑ Scroll up to load more" },
    emptyTitle: { zh: "开始对话，让我帮你写代码", en: "Start a conversation, let me help you code" },
    connecting: { zh: "正在连接服务器...", en: "Connecting to server..." },
    thinking: { zh: "思考中...", en: "Thinking..." },
  },

  // InputArea
  input: {
    placeholder: { zh: "输入消息... (Enter 发送, Ctrl+V 粘贴图片)", en: "Type a message... (Enter to send, Ctrl+V to paste image)" },
    aiThinking: { zh: "AI 正在思考...", en: "AI is thinking..." },
    cancel: { zh: "取消", en: "Cancel" },
  },

  // MessageBubble
  bubble: {
    fork: { zh: "从这条消息分叉新对话", en: "Fork from this message" },
    copy: { zh: "复制", en: "Copy" },
    reasoning: { zh: "💭 思考过程", en: "💭 Reasoning" },
    toolCalls: { zh: "个工具调用", en: "tool calls" },
    cleanFiles: { zh: "🗑️ 清理过程文件", en: "🗑️ Clean up files" },
    delete: { zh: "删除", en: "Delete" },
    cancel: { zh: "取消", en: "Cancel" },
    expand: { zh: "展开", en: "Expand" },
    collapse: { zh: "收起", en: "Collapse" },
    copyMessage: { zh: "复制消息", en: "Copy message" },
    copied: { zh: "已复制", en: "Copied" },
    regenerate: { zh: "重新生成", en: "Regenerate" },
  },

  // MessageBubble subagent status
  message: {
    subagent: { zh: "子智能体", en: "Sub-agent" },
    completed: { zh: "完成", en: "completed" },
    failed: { zh: "失败", en: "failed" },
    running: { zh: "运行中...", en: "running..." },
  },
};

/** Helper to get a string for current language */
export function t(key: { zh: string; en: string }): string {
  return key[getLang()];
}
