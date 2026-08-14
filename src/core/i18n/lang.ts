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
globalChats: { zh: "全局对话", en: "Global Chats" },
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
    renameSession: { zh: "重命名", en: "Rename" },
    copySessionId: { zh: "复制对话 ID", en: "Copy Chat ID" },
    sessionToday: { zh: "今天", en: "Today" },
    sessionEarlier: { zh: "更早", en: "Earlier" },
    collapseSidebar: { zh: "折叠侧栏", en: "Collapse" },
    expandSidebar: { zh: "展开侧栏", en: "Expand" },
    expandInput: { zh: "展开输入框", en: "Expand input" },
    collapseInput: { zh: "收起输入框", en: "Collapse input" },
    disabledHint: { zh: "AI 正在处理中，请等待完成或点击 ■ 取消", en: "AI is working, wait or click ■ to cancel" },
    segmented: { zh: "分段模式", en: "Segmented" },
    unified: { zh: "统一模式", en: "Unified" },
    cicd: { zh: "CI/CD", en: "CI/CD" },
    perf: { zh: "性能", en: "Perf" },
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
    segmentedMode: { zh: "分段模式", en: "Segmented" },
    unifiedMode: { zh: "统一模式", en: "Unified" },
    segmentedModeHint: { zh: "每轮迭代独立显示", en: "Each iteration shown separately" },
    unifiedModeHint: { zh: "所有内容合并显示", en: "All content merged into one" },
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
    edit: { zh: "编辑", en: "Edit" },
    editAndResend: { zh: "编辑并重发", en: "Edit & Resend" },
    save: { zh: "保存", en: "Save" },
    like: { zh: "赞", en: "Like" },
    dislike: { zh: "踩", en: "Dislike" },
    reEdit: { zh: "恢复到输入框", en: "Restore to input" },
  },

  // MessageBubble subagent status
  message: {
    subagent: { zh: "子智能体", en: "Sub-agent" },
    completed: { zh: "完成", en: "completed" },
    failed: { zh: "失败", en: "failed" },
    running: { zh: "运行中...", en: "running..." },
  },

  // Scrollbar & navigation
  scroll: {
    scrollToBottom: { zh: "回到底部", en: "Scroll to bottom" },
    newMessages: { zh: "条新消息", en: "new messages" },
    markers: { zh: "消息标记", en: "Message markers" },
  },

  // P1: Correction Mode
  correctionMode: {
    label: { zh: "事实核查", en: "Fact Check" },
    tooltip: { zh: "开启后 AI 回复会经过事实核查", en: "Enable fact-checking after AI responses" },
  },
  correction: {
    title: { zh: "事实核查结果", en: "Fact Check Result" },
    original: { zh: "原始回复", en: "Original" },
    corrected: { zh: "修正后", en: "Corrected" },
    noChanges: { zh: "无需修正", en: "No changes needed" },
    tabDiff: { zh: "对比", en: "Diff" },
    tabChanges: { zh: "变更", en: "Changes" },
    apply: { zh: "应用修正", en: "Apply Correction" },
    dismiss: { zh: "保留原回复", en: "Keep Original" },
  },
  clarification: {
    required: { zh: "必填项", en: "Required" },
    requiredMark: { zh: " *", en: " *" },
    placeholder: { zh: "请输入您的回答...", en: "Enter your answer..." },
    submit: { zh: "提交", en: "Submit" },
    cancel: { zh: "取消", en: "Cancel" },
  },
  pipeline: {
    title: { zh: "继续下一步", en: "Continue to Next Step" },
    contextTitle: { zh: "选择上下文", en: "Select Context" },
    promptTitle: { zh: "自定义提示", en: "Custom Prompt" },
    promptPlaceholder: { zh: "输入您的提示（可选）...", en: "Enter your prompt (optional)..." },
    modeTitle: { zh: "执行模式", en: "Execution Mode" },
    modeNew: { zh: "新对话", en: "New Chat" },
    modeAppend: { zh: "追加到当前对话", en: "Append to Current Chat" },
    selectRequired: { zh: "请选择至少一项上下文或输入提示", en: "Select at least one context item or enter a prompt" },
    message: { zh: "消息", en: "Message" },
    notebook: { zh: "笔记", en: "Notebook" },
    table: { zh: "表格", en: "Table" },
    submit: { zh: "开始", en: "Start" },
    cancel: { zh: "取消", en: "Cancel" },
  },
  workbench: {
    title: { zh: "代码工作台", en: "Code Workbench" },
    expand: { zh: "展开工作台", en: "Expand Workbench" },
    activeTools: { zh: "执行中的工具", en: "Running Tools" },
    modifiedFiles: { zh: "修改的文件", en: "Modified Files" },
  },
  todoList: {
    title: { zh: "待办事项", en: "Todo List" },
    pending: { zh: "待办", en: "Pending" },
    inProgress: { zh: "进行中", en: "In Progress" },
    completed: { zh: "已完成", en: "Completed" },
  },
  guidance: {
    title: { zh: "引导消息", en: "Guidance Messages" },
  },
  regenerateModel: {
    title: { zh: "选择重新生成模型", en: "Select Regenerate Model" },
  },

  // P2: Quick Access & Phrases
  quickAccess: {
    title: { zh: "快速访问", en: "Quick Access" },
    search: { zh: "搜索...", en: "Search..." },
    favorites: { zh: "收藏", en: "Favorites" },
    allAgents: { zh: "所有 Agent", en: "All Agents" },
  },
  quickPhrase: {
    title: { zh: "快捷短语", en: "Quick Phrases" },
    all: { zh: "全部", en: "All" },
    coding: { zh: "编程", en: "Coding" },
    review: { zh: "代码审查", en: "Code Review" },
    test: { zh: "测试", en: "Testing" },
    debug: { zh: "调试", en: "Debugging" },
    other: { zh: "其他", en: "Other" },
  },
  promptDraft: {
    title: { zh: "Prompt 草稿", en: "Prompt Drafts" },
    compareTitle: { zh: "版本对比", en: "Version Comparison" },
    version: { zh: "版本", en: "Version" },
    useThis: { zh: "使用此版本", en: "Use This Version" },
    load: { zh: "加载", en: "Load" },
    compare: { zh: "对比", en: "Compare" },
  },
  onboarding: {
    skip: { zh: "跳过", en: "Skip" },
    previous: { zh: "上一步", en: "Previous" },
    next: { zh: "下一步", en: "Next" },
    finish: { zh: "完成", en: "Finish" },
  },
  streaming: {
    thinking: { zh: "思考中", en: "Thinking" },
    searching: { zh: "搜索中", en: "Searching" },
    coding: { zh: "编码中", en: "Coding" },
    reviewing: { zh: "审查中", en: "Reviewing" },
  },
  sources: {
    title: { zh: "来源引用", en: "Source References" },
  },

  // P3: Multimedia
  gallery: {
    download: { zh: "下载", en: "Download" },
  },
  video: {
    download: { zh: "下载", en: "Download" },
  },
  generateMode: {
    text: { zh: "文本", en: "Text" },
    image: { zh: "图像", en: "Image" },
    video: { zh: "视频", en: "Video" },
  },
  resolution: {
    label: { zh: "分辨率", en: "Resolution" },
  },

  // P4: Advanced Features
  context: {
    prefix: { zh: "上下文：", en: "Context: " },
  },
  mention: {
    title: { zh: "提及", en: "Mention" },
    noResults: { zh: "无结果", en: "No results" },
  },
  skills: {
    title: { zh: "技能", en: "Skills" },
    noResults: { zh: "无结果", en: "No results" },
  },
  sourceSelector: {
    title: { zh: "选择知识库来源", en: "Select Knowledge Sources" },
  },

  // P3-26: Voice / Speech
  voice: {
    // Input area — microphone button
    startListening: { zh: "开始语音输入", en: "Start voice input" },
    stopListening: { zh: "停止语音输入", en: "Stop voice input" },
    listening: { zh: "聆听中...", en: "Listening..." },
    speechUnsupported: { zh: "当前浏览器不支持语音识别", en: "Speech recognition not supported" },
    micPermissionDenied: { zh: "麦克风权限被拒绝", en: "Microphone permission denied" },
    // Message bubble — TTS button
    readAloud: { zh: "朗读", en: "Read aloud" },
    stopReading: { zh: "停止朗读", en: "Stop reading" },
    ttsUnsupported: { zh: "当前浏览器不支持语音合成", en: "Text-to-speech not supported" },
    // Settings
    settingsTitle: { zh: "语音设置", en: "Voice Settings" },
    voiceSelect: { zh: "语音", en: "Voice" },
    voiceSelectHint: { zh: "选择系统语音引擎", en: "Select system voice engine" },
    rate: { zh: "语速", en: "Speed" },
    rateHint: { zh: "调整朗读速度 (0.1 - 10.0)", en: "Adjust speech rate (0.1 - 10.0)" },
    pitch: { zh: "音调", en: "Pitch" },
    pitchHint: { zh: "调整朗读音调 (0 - 2.0)", en: "Adjust speech pitch (0 - 2.0)" },
    volume: { zh: "音量", en: "Volume" },
    volumeHint: { zh: "调整朗读音量 (0 - 1.0)", en: "Adjust speech volume (0 - 1.0)" },
    testVoice: { zh: "试听", en: "Test voice" },
    testText: { zh: "这是一段语音合成测试文本。", en: "This is a text-to-speech test." },
    cloudTtsHint: { zh: "如需更高质量的云端 TTS，请在 设置 → 多模态 → TTS 中配置。", en: "For higher quality cloud TTS, configure in Settings → Multimodal → TTS." },
    browserTts: { zh: "浏览器内置 TTS", en: "Browser built-in TTS" },
    cloudTts: { zh: "云端 TTS (多模态设置)", en: "Cloud TTS (Multimodal settings)" },
    useCloudTts: { zh: "优先使用云端 TTS", en: "Prefer cloud TTS" },
    useCloudTtsHint: { zh: "启用后，朗读按钮将调用云端 TTS API（需在多模态设置中配置）", en: "When enabled, read aloud uses cloud TTS API (requires configuration in Multimodal settings)" },
  },

  // P3-29: CI/CD Integration
  cicd: {
    title: { zh: "CI/CD 管理", en: "CI/CD Management" },
    repoUrl: { zh: "仓库地址", en: "Repository URL" },
    repoUrlPlaceholder: { zh: "owner/repo 或 https://github.com/owner/repo", en: "owner/repo or https://github.com/owner/repo" },
    load: { zh: "加载", en: "Load" },
    tokenMissing: { zh: "未配置 GitHub Token，请在设置中添加 codem-github-token", en: "GitHub Token not configured. Add codem-github-token in Settings." },
    summary: { zh: "概览", en: "Summary" },
    total: { zh: "总计", en: "Total" },
    success: { zh: "成功", en: "Success" },
    failure: { zh: "失败", en: "Failure" },
    running: { zh: "运行中", en: "Running" },
    cancelled: { zh: "已取消", en: "Cancelled" },
    recentRuns: { zh: "最近运行", en: "Recent Runs" },
    noRuns: { zh: "暂无运行记录", en: "No runs found" },
    retry: { zh: "重试", en: "Retry" },
    cancel: { zh: "取消", en: "Cancel" },
    cancelRun: { zh: "取消运行", en: "Cancel Run" },
    trigger: { zh: "触发", en: "Trigger" },
    triggerDispatch: { zh: "手动触发", en: "Trigger Dispatch" },
    branch: { zh: "分支", en: "Branch" },
    event: { zh: "触发事件", en: "Event" },
    status: { zh: "状态", en: "Status" },
    conclusion: { zh: "结果", en: "Conclusion" },
    time: { zh: "时间", en: "Time" },
    viewOnGithub: { zh: "在 GitHub 查看", en: "View on GitHub" },
    generateWorkflow: { zh: "生成 Workflow", en: "Generate Workflow" },
    projectType: { zh: "项目类型", en: "Project Type" },
    preview: { zh: "预览", en: "Preview" },
    copyYaml: { zh: "复制 YAML", en: "Copy YAML" },
    copied: { zh: "已复制", en: "Copied" },
    saveToFile: { zh: "保存到文件", en: "Save to File" },
    saved: { zh: "已保存", en: "Saved" },
    saveError: { zh: "保存失败", en: "Save failed" },
    selectProjectType: { zh: "选择项目类型", en: "Select project type" },
    fetching: { zh: "获取中...", en: "Fetching..." },
    loadError: { zh: "加载失败", en: "Load failed" },
    jobs: { zh: "任务详情", en: "Job Details" },
    steps: { zh: "步骤", en: "Steps" },
    expand: { zh: "展开", en: "Expand" },
    collapse: { zh: "收起", en: "Collapse" },
    refresh: { zh: "刷新", en: "Refresh" },
    autoRefresh: { zh: "自动刷新", en: "Auto refresh" },
  },

  // P3-30: Performance Dashboard
  perf: {
    title: { zh: "性能监控仪表盘", en: "Performance Dashboard" },
    overview: { zh: "总览", en: "Overview" },
    sessions: { zh: "会话", en: "Sessions" },
    latency: { zh: "时延", en: "Latency" },
    eventTrend: { zh: "事件趋势", en: "Event Trend" },
    totalEvents: { zh: "事件总数", en: "Total Events" },
    totalSessions: { zh: "会话总数", en: "Total Sessions" },
    recentRate: { zh: "最近事件速率", en: "Recent Event Rate" },
    eventsPerMin: { zh: "事件/分钟", en: "events/min" },
    eventsByType: { zh: "按事件类型", en: "Events by Type" },
    noData: { zh: "暂无遥测数据", en: "No telemetry data" },
    sessionId: { zh: "会话 ID", en: "Session ID" },
    eventCount: { zh: "事件数", en: "Event Count" },
    duration: { zh: "持续时间", en: "Duration" },
    firstEvent: { zh: "首次事件", en: "First Event" },
    lastEvent: { zh: "最后事件", en: "Last Event" },
    eventName: { zh: "事件名称", en: "Event Name" },
    count: { zh: "次数", en: "Count" },
    avgMs: { zh: "平均(ms)", en: "Avg (ms)" },
    minMs: { zh: "最小(ms)", en: "Min (ms)" },
    maxMs: { zh: "最大(ms)", en: "Max (ms)" },
    p50Ms: { zh: "P50(ms)", en: "P50 (ms)" },
    p95Ms: { zh: "P95(ms)", en: "P95 (ms)" },
    refresh: { zh: "刷新", en: "Refresh" },
    autoRefresh: { zh: "自动刷新(10s)", en: "Auto refresh (10s)" },
    clearAll: { zh: "清空数据", en: "Clear All Data" },
    clearConfirm: { zh: "确定清空所有遥测数据？", en: "Clear all telemetry data?" },
    exportOTel: { zh: "导出 OTel", en: "Export OTel" },
    exportCopied: { zh: "OTel JSON 已复制到剪贴板", en: "OTel JSON copied to clipboard" },
    last5Min: { zh: "近 5 分钟", en: "Last 5 min" },
    last30Min: { zh: "近 30 分钟", en: "Last 30 min" },
    last60Min: { zh: "近 60 分钟", en: "Last 60 min" },
  },

  // P3-31: Ollama (Offline LLM)
  ollama: {
    title: { zh: "Ollama 本地模型", en: "Ollama Local Models" },
    settingsTitle: { zh: "Ollama 设置", en: "Ollama Settings" },
    baseUrl: { zh: "Ollama 服务地址", en: "Ollama Base URL" },
    baseUrlHint: { zh: "默认 http://localhost:11434", en: "Default: http://localhost:11434" },
    autoDetect: { zh: "自动检测本地模型", en: "Auto-detect local models" },
    autoDetectHint: { zh: "启动时自动拉取已安装的模型列表", en: "Auto-fetch installed models on startup" },
    connectionStatus: { zh: "连接状态", en: "Connection Status" },
    connected: { zh: "已连接", en: "Connected" },
    disconnected: { zh: "未连接", en: "Disconnected" },
    checking: { zh: "检测中...", en: "Checking..." },
    modelCount: { zh: "已安装模型", en: "Installed Models" },
    models: { zh: "可用模型", en: "Available Models" },
    noModels: { zh: "暂无已安装模型，请先在 Ollama 中拉取模型", en: "No models installed. Pull a model in Ollama first." },
    checkConnection: { zh: "测试连接", en: "Test Connection" },
    refreshModels: { zh: "刷新模型列表", en: "Refresh Models" },
    installHint: { zh: "提示：在终端运行 `ollama pull llama3.2` 安装模型", en: "Tip: Run `ollama pull llama3.2` in terminal to install a model" },
    offlineMode: { zh: "离线模式", en: "Offline Mode" },
    offlineModeHint: { zh: "本地运行，无需 API Key，完全隐私", en: "Runs locally, no API key needed, full privacy" },
    save: { zh: "保存", en: "Save" },
    saved: { zh: "设置已保存", en: "Settings saved" },
    connectError: { zh: "无法连接 Ollama，请确认服务已启动", en: "Cannot connect to Ollama. Make sure the service is running." },
    downloadOllama: { zh: "下载 Ollama", en: "Download Ollama" },
  },
};

/** Helper to get a string for current language */
export function t(key: { zh: string; en: string }): string {
  return key[getLang()];
}
