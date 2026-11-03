/**
 * 共享 UI 组件（阶段 2 第一版）。
 *
 * 形状刻意保持"哑组件"：只吃 props、不碰 transport。
 * 桌面与手机各自把自己的数据源接进来（本地 store / `HostClient`），组件只有一份。
 */
import * as React from "react";

import { Markdown } from "./markdown";
import { ToolCardView } from "./tool-card";

import type { MessageView } from "./session-view";
import { runStateLabel, sessionMeta, toolCardTitle } from "./session-view";

export interface SessionSummaryView {
  id: string;
  title: string;
  messageCount?: number;
  lastMessageAt?: number;
}

export function Header(props: {
  title: string;
  state: string | null;
  connected: boolean;
  onOpenFiles?: () => void;
  /** 窄屏第三列被隐藏时，用整屏「变更」入口承接（能力表没有 changes 时不传） */
  onOpenChanges?: () => void;
  onOpenInfo?: () => void;
  onBack?: () => void;
  /**
   * 「收起列表 / 列表」按钮：**只在传了 handler 时渲染**（与 `onOpenFiles` 同构）。
   * 手机壳只在选中会话时传它 —— 没有会话时把列表藏起来等于把入口藏起来。
   * 手机窄屏靠外壳 CSS 隐藏这个按钮（`packages/host/web/index.html` 的 `.sidebar-collapse-toggle`）。
   */
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
}): React.ReactElement {
  const toggleRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (!props.sidebarCollapsed) return;
    /*
     * 收起后侧栏里的按钮被 `display: none` 隐藏，浏览器会把焦点丢给 body —— 键盘用户会「失联」。
     * 这里只接管**焦点已经丢了**的情况：用户正停在输入框/别处时不抢焦点（那比丢焦点更糟）。
     * 正常点击路径下 activeElement 本来就是这颗按钮，因此这段在真机上通常不做事。
     */
    const active = document.activeElement;
    if (!active || active === document.body) toggleRef.current?.focus();
  }, [props.sidebarCollapsed]);
  return (
    <header>
      {props.onBack ? (
        <button className="back-button" onClick={props.onBack} aria-label="back">
          ←
        </button>
      ) : null}
      <span className="title">{props.title}</span>
      {props.onOpenFiles ? (
        <button className="files-button" onClick={props.onOpenFiles}>
          文件
        </button>
      ) : null}
      {props.onOpenChanges ? (
        <button className="files-button changes-button" onClick={props.onOpenChanges}>
          变更
        </button>
      ) : null}
      {props.onOpenInfo ? (
        <button className="files-button" onClick={props.onOpenInfo}>
          信息
        </button>
      ) : null}
      {props.onToggleSidebar ? (
        <button
          ref={toggleRef}
          className="files-button sidebar-collapse-toggle"
          aria-controls="session-sidebar"
          aria-expanded={!props.sidebarCollapsed}
          onClick={props.onToggleSidebar}
        >
          {props.sidebarCollapsed ? "列表" : "收起列表"}
        </button>
      ) : null}
      <span className="pill">{props.connected ? runStateLabel(props.state) : "连接中…"}</span>
    </header>
  );
}

export function SessionList(props: {
  sessions: SessionSummaryView[];
  onOpen: (id: string) => void;
  empty?: string;
  query?: string;
  onQueryChange?: (v: string) => void;
}): React.ReactElement {
  const q = (props.query ?? "").trim().toLowerCase();
  const visible = q ? props.sessions.filter((s) => s.title.toLowerCase().includes(q)) : props.sessions;
  const search = props.onQueryChange ? (
    <input
      className="session-search"
      placeholder="搜索会话"
      value={props.query ?? ""}
      onChange={(e) => props.onQueryChange?.(e.target.value)}
    />
  ) : null;

  if (props.sessions.length === 0) {
    return (
      <div className="session-list">
        {search}
        <div className="banner">{q ? "没有匹配的会话" : (props.empty ?? "选择要远程操作的会话（这些是电脑上的会话）")}</div>
      </div>
    );
  }
  return (
    <div className="session-list">
      {search}
      {visible.map((s) => (
        <button key={s.id} className="session" onClick={() => props.onOpen(s.id)}>
          <div>{s.title || "(未命名会话)"}</div>
          <div className="meta">{sessionMeta(s)}</div>
        </button>
      ))}
      {visible.length === 0 ? <div className="banner">没有匹配的会话</div> : null}
    </div>
  );
}

export function MessageList(props: { views: MessageView[]; streaming?: string }): React.ReactElement {
  return (
    <>
      {props.views.map((v) =>
        v.kind === "tool" ? (
          <ToolCard key={v.id} view={v} />
        ) : (
          <div className={`msg ${v.role}`} key={v.id}>
            <div className="role">{v.roleLabel}</div>
            <div className="body">{v.role === "assistant" ? <Markdown text={v.body} /> : v.body}</div>
          </div>
        ),
      )}
      {props.streaming ? (
        <div className="msg assistant">
          <div className="role">assistant</div>
          <div className="body">
            <Markdown text={props.streaming} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Composer(props: {
  value: string;
  disabled: boolean;
  canSend: boolean;
  canCancel: boolean;
  canGuide?: boolean;
  attachments?: Array<{ id: string; name: string }>;
  canAttach?: boolean;
  attaching?: boolean;
  onAttach?: (file: File) => void;
  onRemoveAttachment?: (id: string) => void;
  onChange: (v: string) => void;
  onSend: () => void;
  onGuide?: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <footer>
      {props.attachments && props.attachments.length > 0 ? (
        <div className="attach-chips">
          {props.attachments.map((a) => (
            <span className="attach-chip" key={a.id}>
              {a.name}
              <button onClick={() => props.onRemoveAttachment?.(a.id)} aria-label="remove attachment">×</button>
            </span>
          ))}
        </div>
      ) : null}
      {props.canAttach ? (
        <label className="attach-button">
          附件
          <input
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) props.onAttach?.(f);
              e.target.value = "";
            }}
          />
        </label>
      ) : null}
      <textarea
        value={props.value}
        placeholder="发一条消息（⌘/Ctrl+Enter 发送）"
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && props.canSend) props.onSend();
        }}
      />
      {props.canCancel ? (
        <>
          {props.canGuide && props.onGuide && props.value.trim() ? (
            <button className="guide-button" onClick={props.onGuide}>
              引导
            </button>
          ) : null}
          <button onClick={props.onCancel}>停止</button>
        </>
      ) : (
        <button className="primary" disabled={!props.canSend || props.disabled} onClick={props.onSend}>
          发送
        </button>
      )}
    </footer>
  );
}

export function Banner(props: { text: string; error?: boolean }): React.ReactElement {
  return <div className={`banner${props.error ? " error" : ""}`}>{props.text}</div>;
}


/**
 * 审批卡已升级为**共享决策卡**（`./approval-card`，桌面四个入口 + 手机同一份实现）。
 * 这里只保留 Host 视图类型的外链，避免 `use-session-chat` 等消费方改 import。
 */
export type { ApprovalItem } from "./approval-card";


/** 「继续」条：上一轮正常结束后出现，**用户点击**才发下一轮（不做自动续跑） */
export function ContinueBar(props: { onContinue: () => void; disabled?: boolean }): React.ReactElement {
  return (
    <div className="continue-bar">
      <span className="continue-hint">上一轮结束了</span>
      <button className="primary" disabled={props.disabled} onClick={props.onContinue}>
        继续
      </button>
    </div>
  );
}



/** 工具卡：共享 ToolCardView（数据来自 session-view 的 ToolInfo） */
function ToolCard(props: {
  view: { toolName: string; toolStatus: string; output?: string; toolArgs?: string; argsSummary?: string; duration?: number };
}): React.ReactElement {
  return (
    <ToolCardView
      toolName={props.view.toolName}
      toolArgs={props.view.toolArgs}
      toolResult={props.view.output}
      status={props.view.toolStatus === "running" ? "running" : props.view.toolStatus === "error" ? "error" : "done"}
      duration={props.view.duration}
      argsSummary={props.view.argsSummary}
    />
  );
}
