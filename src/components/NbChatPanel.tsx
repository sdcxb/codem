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
import { Spinner } from "./ui/Spinner";
/** 第 184 波（F5）：删除失败不许抹记录 —— 与 ChatPanel 共用同一份实现 */
import { deleteGeneratedFiles } from "../core/ui/generated-files-cleanup";

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
  /**
   * ## 第 184 波（F6）：笔记本侧必须与主聊天**同一套三态**
   *
   * 修前这里只取 `messages` / `isStreaming` / 翻页那几项 —— **没有**
   * `messagesReadUnavailable` / `messagesLoading`，于是历史**读失败**或**仍在加载**时，
   * 下面 `messages.length === 0` 直接渲染「开始知识问答」欢迎页：
   * 把"读不到"说成了"这个会话是空的"（`store.ts:196-225` 记着真机事故：
   * 用户以为 27 条消息的会话被清空了），且**连重试入口都没有**。
   * 主面板对同一事实有三态（`ChatPanel.tsx:865` 在途 / `:879` 读不到+重试 / `:905` 确实空）。
   */
  const { messages, isStreaming, activeSessions, removeGeneratedFiles, hasMoreMessages, isLoadingMore, loadMoreMessages, loadMoreReadUnavailable, messagesReadUnavailable, messagesLoading } = useAppStore();
  const { currentSession } = useProjectStore();
  const [showReasoning, setShowReasoning] = useState(true);
  const [quoteContext, setQuoteContext] = useState<string | null>(null);
  const [suggestionPrompt, setSuggestionPrompt] = useState<string | null>(null);
  /** 「清理过程文件」失败时的如实提示（F5：失败不许抹记录） */
  const [cleanupFailed, setCleanupFailed] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useScrollState(messagesContainerRef, [messages.length]);
  useUnreadMessagesTracker(messages.length, isStreaming);

  const isSessionStreaming = !currentSessionId ? isStreaming : activeSessions.has(currentSessionId);

  const handleReEditInternal = (content: string) => {
    setSuggestionPrompt(content);
  };

  /**
   * 「清理过程文件」（第 184 波 F5）。
   *
   * 修前与 `ChatPanel` 逐字相同（`delete_file` 失败只 `console.warn`，
   * 然后**无条件** `removeGeneratedFiles`）⇒ 文件还在、记录没了、不可逆。
   * 现在只对真的删掉的条目抹记录，失败项保留并提示。
   */
  const handleDeleteFiles = async (messageId: string, files: string[]) => {
    const { deleted, failed } = await deleteGeneratedFiles({ files, area: "nbChatPanel.deleteFiles" });
    if (deleted.length > 0) removeGeneratedFiles(messageId, deleted);
    setCleanupFailed(
      failed.length === 0
        ? null
        : `${failed.length}${isZh ? " 个文件没能删除（文件仍在磁盘上，清单条目已保留）：" : " file(s) could not be deleted (still on disk, kept in the list): "}${failed.map((f) => f.file).join("、")}`,
    );
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  // 欢迎页（含建议问题）只在"读到了、确实空"时出现：加载中与读不到都不算（F6）
  const showGuidedQuestions =
    guidedQuestions.length > 0 && messages.length === 0 && !messagesReadUnavailable && !messagesLoading;

  return (
    <div className="nb-chat-panel-inner">
      {cleanupFailed && (
        <div className="chat-cleanup-failed" data-testid="nb-chat-cleanup-failed" role="alert">
          <span>{cleanupFailed}</span>
          <button type="button" className="chat-cleanup-failed-dismiss" onClick={() => setCleanupFailed(null)}>
            {isZh ? "知道了" : "Dismiss"}
          </button>
        </div>
      )}
      {/* 消息列表 + 建议问题融为一体 */}
      <div className="nb-chat-body" ref={messagesContainerRef}>
        {/*
          ## 第 184 波（F6）：与 ChatPanel **同一套三态**（读失败 ≠ 空）
          顺序有意义：先"在途"、再"读不到"、最后才是"确实空"（欢迎页）。
        */}
        {messages.length === 0 && messagesLoading && !messagesReadUnavailable && (
          <div className="nb-chat-welcome" data-testid="nb-messages-loading" role="status">
            {/* 第 185 波：加载指示统一走共享 <Spinner />（裸 Loader2 会顶破 COND-2 的棘轮） */}
            <Spinner size="sm" label="" />
            <p className="nb-chat-welcome-title">{isZh ? '正在读取历史消息…' : 'Loading message history…'}</p>
            <p className="nb-chat-welcome-desc">
              {isZh ? '这个会话的消息索引正在加载，通常一瞬间就好。' : 'This session\'s message index is loading on demand — usually instant.'}
            </p>
          </div>
        )}
        {messages.length === 0 && messagesReadUnavailable && (
          <div className="nb-chat-welcome" data-testid="nb-messages-unavailable" role="alert">
            <p className="nb-chat-welcome-title">{isZh ? '暂时读不到这个会话的历史消息' : "Can't read this session's history right now"}</p>
            <p className="nb-chat-welcome-desc">
              {isZh
                ? '这不代表消息丢了 —— 历史正文保存在追加日志里。可能是存储引擎还在启动或暂时不可用。'
                : 'Your messages are not lost — the authoritative log still has them. The storage engine may still be starting or temporarily unavailable.'}
            </p>
            <button
              type="button"
              className="nb-chat-welcome-retry"
              data-testid="nb-messages-retry"
              onClick={() => currentSessionId && useAppStore.getState().loadMessages(currentSessionId)}
            >
              {isZh ? '重新读取' : 'Retry'}
            </button>
          </div>
        )}
        {messages.length === 0 && !messagesReadUnavailable && !messagesLoading && (
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
                    <Loader2 className="icon-xs spin" />
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
        )}
        {messages.length > 0 && (
          <>
            {/*
              第 48 轮：与 `ChatPanel` 同一条判据 —— 翻页"读不到"不许渲染成"没有更多"。
              原来这里只有 `hasMoreMessages` 一个条件，而读失败会把它置 false，
              于是"加载更多"这个入口直接消失，用户再没有重试的机会。
            */}
            {loadMoreReadUnavailable && (
              <div className="nb-chat-load-more is-unavailable" data-testid="nb-load-more-unavailable">
                <span>{isZh ? '暂时读不到更早的消息（这不代表没有历史）' : 'Can\'t read earlier messages right now (this doesn\'t mean there are none)'}</span>
                <span
                  className="nb-chat-load-more-retry"
                  onClick={() => currentSessionId && !isLoadingMore && loadMoreMessages(currentSessionId)}
                >
                  {isLoadingMore ? (isZh ? '重试中…' : 'Retrying…') : (isZh ? '重试' : 'Retry')}
                </span>
              </div>
            )}
            {hasMoreMessages && !loadMoreReadUnavailable && (
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
