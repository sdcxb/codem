/**
 * NewChatPage — 新对话空状态引导页
 *
 * 当没有消息时显示的引导页面，包含：
 * - 居中 Logo + 欢迎标题
 * - 功能描述副标题
 * - 可点击的建议卡片（快速开始对话）
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { memo, useCallback } from "react";
import { Code2, FileSearch, Bug, BookOpen, Lightbulb, Rocket } from "lucide-react";

interface NewChatPageProps {
  /** 应用名称 */
  appName?: string;
  /** 点击建议卡片回调 */
  onSuggestionClick?: (suggestion: string) => void;
  /** 是否已连接 */
  connected?: boolean;
}

interface SuggestionItem {
  icon: typeof Code2;
  title: string;
  desc: string;
  prompt: string;
}

const SUGGESTIONS_ZH: SuggestionItem[] = [
  {
    icon: Code2,
    title: "编写代码",
    desc: "让我帮你编写、重构或调试代码",
    prompt: "帮我编写一个 ",
  },
  {
    icon: FileSearch,
    title: "分析项目",
    desc: "理解项目结构和代码逻辑",
    prompt: "分析当前项目的结构和主要功能",
  },
  {
    icon: Bug,
    title: "修复 Bug",
    desc: "诊断并修复代码中的问题",
    prompt: "我发现了一个 bug：",
  },
  {
    icon: BookOpen,
    title: "学习知识",
    desc: "从知识笔记本中检索相关信息",
    prompt: "帮我查找关于 ",
  },
];

const SUGGESTIONS_EN: SuggestionItem[] = [
  {
    icon: Code2,
    title: "Write Code",
    desc: "Let me help you write, refactor, or debug code",
    prompt: "Help me write a ",
  },
  {
    icon: FileSearch,
    title: "Analyze Project",
    desc: "Understand project structure and logic",
    prompt: "Analyze the current project structure and main features",
  },
  {
    icon: Bug,
    title: "Fix Bug",
    desc: "Diagnose and fix issues in your code",
    prompt: "I found a bug: ",
  },
  {
    icon: BookOpen,
    title: "Learn",
    desc: "Retrieve relevant information from notebooks",
    prompt: "Help me find information about ",
  },
];

export const NewChatPage = memo(function NewChatPage({
  appName = "Codem",
  onSuggestionClick,
  connected = true,
}: NewChatPageProps) {
  const lang = typeof window !== "undefined" ? (document.documentElement.lang === "zh" ? "zh" : "en") : "en";
  const suggestions = lang === "zh" ? SUGGESTIONS_ZH : SUGGESTIONS_EN;

  const handleClick = useCallback((prompt: string) => {
    onSuggestionClick?.(prompt);
  }, [onSuggestionClick]);

  return (
    <div className="new-chat-page">
      <div className="new-chat-logo">
        <Rocket size={32} />
      </div>
      <h1 className="new-chat-title">{appName}</h1>
      <p className="new-chat-subtitle">
        {lang === "zh"
          ? "你的智能编程助手。可以编写代码、分析项目、修复 Bug，还能管理知识笔记本和自动化任务。"
          : "Your intelligent coding assistant. Write code, analyze projects, fix bugs, manage notebooks and automate tasks."}
      </p>
      {connected ? (
        <div className="new-chat-suggestions">
          {suggestions.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={i}
                className="new-chat-suggestion"
                onClick={() => handleClick(item.prompt)}
              >
                <Icon size={20} className="new-chat-suggestion-icon" />
                <div className="new-chat-suggestion-body">
                  <span className="new-chat-suggestion-title">{item.title}</span>
                  <span className="new-chat-suggestion-desc">{item.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="new-chat-subtitle" style={{ color: "var(--text-muted)" }}>
          {lang === "zh" ? "正在连接..." : "Connecting..."}
        </p>
      )}
    </div>
  );
});
