/**
 * NbChatPanel — 笔记本专用精简对话面板
 *
 * 复用主应用的 MessageBubble 和 InputArea 组件，
 * 但去掉了顶部 bar、空状态首页（Codem 介绍 + 快速访问）、底部 bar（全局对话/本地处理/已连接）。
 * 建议问题融入对话区域，与 LLM 对话融为一体。
 * 模型选择保留在 InputArea 的编辑框内。
 */

import React, { useState, useRef, useEffect } from "react";
import { MessageBubble } from "./MessageBubble";
import { InputArea } from "./InputArea";
import { useAppStore, type Message } from "../store";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";
import { motion, AnimatePresence } from "framer-motion";
import type { CollaborationMode } from "../core/agent/agent";
import type { MessageAttachment } from "../store";
import { ScrollToBottomIndicator } from "./ScrollToBottomIndicator";
import { useScrollState, useUnreadMessagesTracker } from "../hooks/useScrollState";
import { Sparkles, Loader2 } from "lucide-react";

interface NbChatPanelProps {
  onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void;
  onCancel: () => void;
  onSendGuidance?: (message: string) => void;
  sessionId?: string;
  connected: boolean;
  model: string;
  onModelChange: (model: string) => void;
  mode?: "cli" | "api";
  collaborationMode?: CollaborationMode;
  onModeChange?: (mode: CollaborationMode) => void;
  projectPath?: string;
  currentSessionId?: string;
  onCitationClick?: (sourceName: string) => void;
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
  notebookId?: string;
  /** 建议问题 */
  guidedQuestions: string[];
  loadingQuestions: boolean;
  /** 是否有来源 */
  hasSources: boolean;
}

export function NbChatPanel({
  onSend, onCancel, onSendGuidance,
  sessionId, connected, model, onModelChange,
  mode = "api", collaborationMode = "default", onModeChange,
  projectPath, currentSessionId,
  onCitationClick, onSourceClick, notebookId,
  guidedQuestions, loadingQuestions, hasSources,
}: NbChatPanelProps) {
  const lang = useLang();
  const isZh = lang === "zh";
  const { messages, isStreaming, activeSessions, removeGeneratedFiles, hasMoreMessages, isLoadingMore, loadMoreMessages } = useAppStore();
  const { currentSession } = useProjectStore();
  const [showReasoning, setShowReasoning] = useState(true);
  const [quoteContext, setQuoteContext] = useState<string | null>(null);
  const [suggestionPrompt, setSuggestionPrompt] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useScrollState(messagesContainerRef, [messages.length]);
  useUnreadMessagesTracker(messages.length, isStreaming);

  const isSessionStreaming = !currentSessionId ? isStreaming : activeSessions.has(currentSessionId);

  const handleReEditInternal = (content: string) => {
    setSuggestionPrompt(content);
  };

  const handleDeleteFiles = async (messageId: string, files: string[]) => {
    for (const file of files) {
      try {
        await (window as any).__TAURI__?.core.invoke("delete_file", { path: file });
      } catch (e) {
        console.warn("[NbChatPanel] Failed to delete file:", file, e);
      }
    }
    removeGeneratedFiles(messageId, files);
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const showGuidedQuestions = guidedQuestions.length > 0 && messages.length === 0;

  return (
    <div className="nb-chat-panel-inner">
      {/* 消息列表 + 建议问题融为一体 */}
      <div className="nb-chat-body" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div className="nb-chat-welcome">
            {hasSources ? (
              <>
                <Sparkles className="nb-chat-welcome-icon" size={32} />
                <p className="nb-chat-welcome-title">
                  {isZh ? '开始知识问答' : 'Start Knowledge Q&A'}
                </p>
                <p className="nb-chat-welcome-desc">
                  {isZh ? '基于笔记本中的来源，AI 将为你解答问题' : 'AI will answer your questions based on sources in this notebook'}
                </p>
                {/* 建议问题融入对话区域 */}
                {loadingQuestions && (
                  <div className="nb-chat-loading-questions">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>{isZh ? '正在生成建议问题...' : 'Generating questions...'}</span>
                  </div>
                )}
                {showGuidedQuestions && (
                  <div className="nb-chat-suggested-questions">
                    {guidedQuestions.slice(0, 4).map((q, i) => (
                      <button
                        key={i}
                        className="nb-chat-question-card"
                        onClick={() => {
                          if (currentSessionId) {
                            onSend(q);
                          }
                        }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="nb-chat-welcome-title">
                  {isZh ? '开始使用笔记本' : 'Get Started'}
                </p>
                <p className="nb-chat-welcome-desc">
                  {isZh ? '在左侧添加来源，即可开始知识问答' : 'Add sources on the left to start asking questions'}
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {hasMoreMessages && (
              <div className="nb-chat-load-more">
                {isLoadingMore ? (
                  <span>{isZh ? '加载中...' : 'Loading...'}</span>
                ) : (
                  <span onClick={() => currentSessionId && loadMoreMessages(currentSessionId)}>{isZh ? '加载更多' : 'Load more'}</span>
                )}
              </div>
            )}
            {/* 消息列表 */}
            {messages.map((msg, origIndex) => {
              let isLastInTurn = false;
              if (msg.role === "assistant") {
                isLastInTurn = true;
                for (let i = origIndex + 1; i < messages.length; i++) {
                  if (messages[i].role === "user") break;
                  if (messages[i].role === "assistant") {
                    isLastInTurn = false;
                    break;
                  }
                }
              }

              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                >
                  <MessageBubble
                    message={msg}
                    index={origIndex}
                    showReasoning={showReasoning}
                    onDeleteFiles={(files) => handleDeleteFiles(msg.id, files)}
                    isLastInTurn={isLastInTurn}
                    onCitationClick={onCitationClick}
                    onSourceClick={onSourceClick}
                    onEditAndResend={undefined}
                    onReEdit={handleReEditInternal}
                    sessionId={sessionId || currentSession?.id}
                    canEdit={!isSessionStreaming}
                  />
                </motion.div>
              );
            })}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* 编辑框 — 仅保留模型选择，去掉底部 bar */}
      <div className="nb-chat-input-wrapper">
        <InputArea
          sessionKey={currentSessionId}
          onSend={(msg, atts, skills) => { onSend(msg, atts, skills); setQuoteContext(null); }}
          onCancel={onCancel}
          disabled={(!currentSessionId || activeSessions.has(currentSessionId)) || !connected}
          isStreaming={isSessionStreaming}
          noSession={!currentSessionId}
          collaborationMode={collaborationMode}
          onModeChange={onModeChange || (() => {})}
          projectPath={projectPath}
          quoteContext={quoteContext}
          onClearQuote={() => { setQuoteContext(null); }}
          suggestionPrompt={suggestionPrompt}
          onSuggestionConsumed={() => setSuggestionPrompt(null)}
          notebookId={notebookId}
          hideSourceSelector={true}
          model={model}
          onModelChange={onModelChange}
          mode={mode}
          connected={connected}
        />
      </div>
    </div>
  );
}
