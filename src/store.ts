import { create } from "zustand";
import * as MessageStorage from "./core/storage/message";
import type { FeedbackType } from "./core/storage/message";
import { putMessageFeedback } from "./core/llm/feedback";
import { isCompactionInProgress } from "./core/storage/compaction-state";
import { storageUnavailable } from "./core/storage/health";
import { reportPersistFailure } from "./core/storage/persist-failure";

/** 第 90 波：致命状态只上报一次（否则 AutoSave 每几秒刷一条） */
let warnedSaveMessagesFatal = false;

/**
 * 第 91 波（存储压力）：每条消息上次写库时的"内容指纹"。
 *
 * 为什么需要：`saveMessages` 会把**整份消息列表**逐条 `createMessage` 写一遍，
 * 而长会话（用户现场 113 条、内容是大文档）每次自动保存都要做上百条 UPDATE +
 * 每条工具调用先删后插 —— 这些写入都要经过 WASM 里的 SQLite，是"内存访问越界"
 * 最现实的压力来源之一。
 *
 * 指纹 = 长度 + 首尾采样 + 字符码累加（O(n) 纯算术，比一次 SQL 写入便宜两个数量级）。
 * 只有指纹变了才写；跳过的是"自上次保存以来没变过"的消息（绝大多数）。
 */
const persistedFingerprints = new Map<string, Map<string, string>>();

function messageFingerprint(m: Message): string {
  const content = typeof m.content === "string" ? m.content : "";
  const len = content.length;
  const head = content.slice(0, 24);
  const tail = len > 24 ? content.slice(-24) : "";
  let sum = 0;
  for (let i = 0; i < content.length; i++) sum = (sum + content.charCodeAt(i)) % 2147483647;
  const tools = (m.toolCalls ?? []).map((tc) => `${tc.id}:${tc.status ?? ""}:${(tc.result ?? "").length}`).join(",");
  return [
    len,
    sum,
    head,
    tail,
    m.status ?? "",
    m.reasoning?.length ?? 0,
    tools,
    m.generatedFiles?.length ?? 0,
    m.model ?? "",
  ].join("|");
}

/** 测试/会话切换用：清空指纹缓存 */
export function __resetSaveFingerprints(sessionId?: string): void {
  if (sessionId) persistedFingerprints.delete(sessionId);
  else persistedFingerprints.clear();
}

/** Auto-retrieved knowledge source (from notebook RAG, not from tool calls) */
export interface RetrievedSource {
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
  snippet: string;
  score: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  toolCalls?: ToolCall[];
  attachments?: MessageAttachment[];
  status?: "pending" | "streaming" | "done" | "error";
  generatedFiles?: string[];
  /** Sources auto-retrieved from notebook knowledge base (not from tool calls) */
  retrievedSources?: RetrievedSource[];
  /** Structured metadata (e.g. RAG source references, tool results) */
  metadata?: Record<string, any>;
}

export interface MessageAttachment {
  id: string;
  name: string;
  type: "file" | "image" | "code" | "url" | "video" | "audio";
  content?: string;
  preview?: string;
  mimeType?: string;
  size?: number;
  /** Sandbox file path — when the attachment is synced to the workspace, this is the
   * relative path (from workspace root) where the file can be read/grep'd by file tools. */
  sandboxPath?: string;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "done" | "error";
  /** Structured metadata from tool result (e.g. search_notebook source citations) */
  metadata?: Record<string, any>;
}

export interface StepItem {
  title: string;
}

export interface AgentActivity {
  id: string;
  type: "thinking" | "tool";
  label: string;
  status: "running" | "done";
  startedAt: number;
  completedAt?: number;
}

export interface StepProgress {
  current: number;
  total: number; // 0 means unknown (indeterminate progress)
  title: string;
  steps: StepItem[] | null; // Full step plan for hover tooltip
}

export type LLMStatus = "idle" | "connecting" | "streaming" | "executing_tools";

/** A guidance message sent by the user during an active agent run */
export interface GuidanceMessage {
  id: string;
  message: string;
  timestamp: number;
  /** Whether the guidance has been consumed by the agentic loop */
  consumed: boolean;
}

/** Scroll position state for chat panel */
export type ScrollPosition = "bottom" | "near-bottom" | "scrolled-up";

/** Feedback state map: messageId -> 'like' | 'dislike' */
type FeedbackMap = Record<string, FeedbackType>;

interface AppState {
  messages: Message[];
  /**
   * **`messages` 这份列表属于哪个会话**（P0-1，跨会话污染）。
   *
   * ## 为什么必须把这件事变成状态
   *
   * `saveMessages(sessionId)` 原来写的是 `get().messages` —— 也就是
   * "**当前加载的那个会话**"的列表，与传进来的 `sessionId` **没有任何一致性校验**，
   * 然后逐条按调用方给的 sessionId 落库。而落库去向
   * （`MessageStorage.createMessage` → `appendSessionMessage` 的 JSONL 文件名 /
   * FTS / `eventLog.append`）**全部按 sessionId 决定归属、对消息本身零校验**。
   *
   * 于是真机上这个形态就成立了：会话 A 正在流式时切到会话 B，A 的后台
   * `runAgenticLoop` 还在跑，之后每次 `start`/`tool_start`/`tool_complete`/
   * `tool_error`/`finally` 都调 `saveMessages(A)`，而 store 里的 `messages`
   * 已经是 **B 的消息** → B 的每条消息被追加进 **A 的权威日志**。
   * 读路径 `listMessagesMerged` 会把日志合并回结果，所以污染**会真的显示出来**，
   * 而且那是权威副本，不会被索引修正。
   *
   * 所以这里把"列表的归属"记成一个**事实**，让 `saveMessages` 能按事实拒绝
   * （见它的实现：拒绝必须上报，绝不静默、也绝不照写）。
   */
  loadedSessionId: string | null;
  isStreaming: boolean;
  /** Map of sessionId → true for sessions currently running an agentic loop */
  activeSessions: Map<string, boolean>;
  currentModel: string;
  cwd: string;
  streamingMsgId: string | null;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  stepProgress: StepProgress | null;
  agentActivities: AgentActivity[];
  streamStartTime: number | null;
  llmStatus: LLMStatus;
  displayMode: "segmented" | "unified";
  /** Guidance messages sent during the current active run */
  guidanceMessages: GuidanceMessage[];
  /** P0: Message feedback map (messageId -> 'like' | 'dislike') */
  feedback: FeedbackMap;
  /** P0: Whether the user has scrolled up from the bottom of the chat */
  scrollPosition: ScrollPosition;
  /** P0: Whether there are new messages the user hasn't seen (because they scrolled up) */
  hasUnreadMessages: boolean;

  addMessage: (msg: Message) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  appendToMessage: (id: string, content: string) => void;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (messageId: string, toolId: string, update: Partial<ToolCall>) => void;
  setStreaming: (v: boolean) => void;
  /** Mark a session as active (running) or inactive */
  setSessionActive: (sessionId: string, active: boolean) => void;
  /** Check if any session is currently active */
  hasActiveSessions: () => boolean;
  setCurrentModel: (m: string) => void;
  setCwd: (d: string) => void;
  clearMessages: () => void;
  loadMessages: (sessionId: string) => void;
  loadMoreMessages: (sessionId: string, count?: number) => void;
  /**
   * 把消息写进持久层。
   *
   * @param sessionId 落库归属（日志文件名 / FTS / 事件日志都按它决定）
   * @param explicit  **明确要写的那一份消息**。后台会话（`runAgenticLoop` 正在跑的
   *                  会话，而用户已经切走）**只能走这条**：此时 `get().messages`
   *                  已经属于别的会话，写它就等于把别的会话的消息写进 `sessionId`。
   *                  给了 `explicit` 就**以它为准**，不做归属校验（调用方已经声明了归属）。
   *
   *                  不给 `explicit` = "写当前加载的那份列表"，此时**必须**归属一致：
   *                  `loadedSessionId` 存在且 `!== sessionId` 时**拒绝**并如实上报
   *                  （不静默、也不照写）。
   */
  saveMessages: (sessionId: string, explicit?: Message[]) => void;
  removeGeneratedFiles: (messageId: string, files: string[]) => void;
  setStepProgress: (progress: StepProgress | null) => void;
  setAgentActivities: (activities: AgentActivity[]) => void;
  addAgentActivity: (activity: AgentActivity) => void;
  updateAgentActivity: (id: string, update: Partial<AgentActivity>) => void;
  clearAgentActivities: () => void;
  setStreamStartTime: (time: number | null) => void;
  setLLMStatus: (status: LLMStatus) => void;
  setDisplayMode: (mode: "segmented" | "unified") => void;
  /** Add a guidance message to the current run */
  addGuidanceMessage: (msg: GuidanceMessage) => void;
  /** Mark a guidance message as consumed by the loop */
  markGuidanceConsumed: (id: string) => void;
  /** Remove a guidance message once it has been injected into the loop (it no longer stays in the status bar) */
  removeGuidanceMessage: (id: string) => void;
  /** Clear all guidance messages (called when run ends) */
  clearGuidanceMessages: () => void;
  /** P0: Set feedback for a message (persists to DB). sessionId is needed for DB persistence. */
  setFeedback: (messageId: string, feedback: FeedbackType | null, sessionId?: string) => void;
  /** P0: Load feedback for a message from DB */
  loadFeedback: (messageId: string) => void;
  /** P0: Remove messages after a given message (for inline edit) */
  removeMessagesAfter: (messageId: string, includeSelf?: boolean) => void;
  /** P0: Update scroll position state */
  setScrollPosition: (pos: ScrollPosition) => void;
  /** P0: Mark that there are unread messages */
  setHasUnreadMessages: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  loadedSessionId: null,
  isStreaming: false,
  activeSessions: new Map<string, boolean>(),
  currentModel: "codem-auto",
  cwd: "",
  streamingMsgId: null,
  hasMoreMessages: false,
  isLoadingMore: false,
  stepProgress: null,
  agentActivities: [],
  streamStartTime: null,
  llmStatus: "idle" as LLMStatus,
  displayMode: "unified" as "segmented" | "unified",
  guidanceMessages: [],
  feedback: {},
  scrollPosition: "bottom",
  hasUnreadMessages: false,

  addMessage: (msg) => {
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id)) return s;
      return { messages: [...s.messages, msg] };
    });
  },

  updateMessage: (id, update) => set((s) => {
    // Only create a new object for the updated message; keep all other
    // message references identical so React.memo on MessageBubble can skip
    // re-rendering unchanged rows. This is critical for streaming performance
    // — without it, every text_delta/reasoning_delta token causes ALL
    // MessageBubbles to re-render (O(n) per token).
    let found = false;
    const messages = s.messages.map((m) => {
      if (m.id === id) { found = true; return { ...m, ...update }; }
      return m;
    });
    if (!found) return s;
    return { messages };
  }),

  appendToMessage: (id, content) => set((s) => {
    let found = false;
    const messages = s.messages.map((m) => {
      if (m.id === id && content) { found = true; return { ...m, content: m.content + content }; }
      return m;
    });
    if (!found) return s;
    return { messages };
  }),

  addToolCall: (messageId, toolCall) => set((s) => {
    const msg = s.messages.find((m) => m.id === messageId);
    if (!msg) return s;
    if ((msg.toolCalls || []).some((t) => t.id === toolCall.id)) {
      return { messages: s.messages.map((m) => m.id === messageId ? { ...m, toolCalls: (m.toolCalls || []).map((t) => t.id === toolCall.id ? { ...t, ...toolCall } : t) } : m) };
    }
    return { messages: s.messages.map((m) => m.id === messageId ? { ...m, toolCalls: [...(m.toolCalls || []), toolCall] } : m) };
  }),

  updateToolCall: (messageId, toolId, update) => set((s) => ({
    messages: s.messages.map((m) => m.id === messageId ? { ...m, toolCalls: (m.toolCalls || []).map((t) => t.id === toolId ? { ...t, ...update } : t) } : m),
  })),

  setStreaming: (v) => set((s) => {
    // Only clear global streaming UI state, not per-session activeSessions
    if (!v) {
      return { isStreaming: s.activeSessions.size > 0, streamingMsgId: null, stepProgress: null, agentActivities: [], streamStartTime: null, llmStatus: "idle" as LLMStatus };
    }
    return { isStreaming: true };
  }),
  setSessionActive: (sessionId, active) => {
    const next = new Map(get().activeSessions);
    if (active) {
      next.set(sessionId, true);
    } else {
      next.delete(sessionId);
    }
    // isStreaming = true if any session is active
    set({ activeSessions: next, isStreaming: next.size > 0 });
  },
  hasActiveSessions: () => get().activeSessions.size > 0,
  setCurrentModel: (m) => set({ currentModel: m }),
  setCwd: (d) => set({ cwd: d }),
  clearMessages: () => set({ messages: [], loadedSessionId: null, streamingMsgId: null, stepProgress: null, agentActivities: [], streamStartTime: null }),

  loadMessages: (sessionId) => {
    const applyMessages = (messages: ReturnType<typeof MessageStorage.listMessages>) => {
      const INITIAL_LIMIT = 10;
      const totalCount = messages.length;
      const initialMessages = totalCount > INITIAL_LIMIT ? messages.slice(totalCount - INITIAL_LIMIT) : messages;
      set({
        messages: initialMessages,
        // P0-1：列表归属是**这份数据的属性**，与列表在同一次 set 里落定 ——
        // 分开写会留下"列表已是 B 的、归属还写着 A"的窗口，而 saveMessages 的守卫
        // 正是按这个字段判定的。
        loadedSessionId: sessionId,
        hasMoreMessages: totalCount > INITIAL_LIMIT,
        isLoadingMore: false,
      });
      return totalCount;
    };
    /**
     * 迟到的读**不得**覆盖已切换的会话（P0-1 的同一类时序问题）。
     *
     * `onSessionMessagesReady` / `reloadSessionMessages` 的回调是异步来的：
     * 用户在等待期间切走之后，它们若照样 `applyMessages`，就等于"把 A 的历史
     * 铺进 B 的界面"，并且还会把 `loadedSessionId` 改回 A（于是 B 的落库被守卫拒绝，
     * 表现成"后台消息又存不进去了"）。归属不一致时直接丢弃这次结果。
     *
     * 判据用"同步读那一刻的归属"（`origin`）而不是 `get().loadedSessionId`：
     * 同一个 tick 里紧接着的第二次 `loadMessages` 会立刻改掉后者，那是**切换到别的会话**，
     * 不是"迟到的回调"。只有跨 tick 之后归属变了才算迟到。
     *
     * ⚠️ `origin` 必须在下面那次同步 `applyMessages` **之后**取（它才是"同步读的结果"）。
     */
    let origin: string | null = null;
    const applyIfStillLoaded = (messages: ReturnType<typeof MessageStorage.listMessages>) => {
      if (get().loadedSessionId !== origin) return 0;
      return applyMessages(messages);
    };

    try {
      const totalCount = applyMessages(MessageStorage.listMessages(sessionId));
      // 上面那次同步读**就是**本次的归属；此后归属若被别的 loadMessages 改掉，
      // 说明用户已经切走 —— 下面这些迟到的回调一律不再回写。
      origin = sessionId;
      console.log(`[Store] loadMessages sessionId=${sessionId} → ${totalCount} 条`);

      /**
       * 空结果 + 端口在 → 订阅一次"镜像就绪"，就绪后重读（第 33 轮修的真机缺陷）。
       *
       * 为什么会空：读路径的规则是"镜像未完整加载完不路由"（防读写分裂），
       * 而进会话的第一次读正好落在加载窗口内 —— 那时日志也还没 hydrate，
       * 两条兜底同时为空，于是 0 条；`loadMessages` 是同步单次调用，没人再读第二次。
       * 真机实测：一个**确实有 27 条消息**的会话点开是空白，且无任何报错。
       *
       * 这里只订阅一次（镜像加载完成时回调），不是轮询；
       * 重读结果为 0 就停下，不留循环。
       */
      if (totalCount === 0) {
        /**
         * 运行期守护（第 37 轮）：**读不到消息时先判断"是不是数据被清空了"**。
         *
         * 文件级取证给出的时间线：应用启动后该会话有 277 条消息，点开它的那一刻
         * WAL 在 1 秒内从 28KB 涨到 1.75MB，紧接着整库 `messages=0`。
         * 也就是说用户是在**使用过程中**丢数据的，而启动自检覆盖不到这段。
         *
         * 所以这里加一道核对：内容归零 + 水位很高 + 旧库有内容 → 立刻恢复，
         * 让用户看不到空列表（恢复完成后重读一次）。
         */
        void (async () => {
          try {
            const [{ guardContentBeforeSessionOpen }, { legacyDbPath }] = await Promise.all([
              import("./core/storage/self-heal"),
              import("./core/storage/bootstrap"),
            ]);
            const heal = await guardContentBeforeSessionOpen(await legacyDbPath());
            if (heal.kind === "restored") {
              /*
               * 恢复完成后必须**作废镜像并重拉**，否则界面停在空列表上 ——
               * 真机实测过这个形态：数据已经救回（`messages=821`），
               * 但镜像里那份"空快照"仍是 `loaded`，读路径继续返回空集合。
               *
               * 另外要把项目/会话列表也重新读一遍：清空时被删掉的会话此刻才回来，
               * `currentSession` 可能指向一个已失效的对象。
               */
              MessageStorage.reloadSessionMessages(sessionId, () => {
                const again = MessageStorage.listMessages(sessionId);
                if (again.length > 0) {
                  applyIfStillLoaded(again);
                  console.warn(
                    `[Store] 内容被清空后已恢复并重拉镜像（上次水位 ${heal.previous?.messages} 条）→ 显示 ${again.length} 条`,
                  );
                }
              });
              // 清空时被删掉的会话此刻才回来，项目/会话列表要重新读一遍
              void import("./core/store").then(({ useProjectStore }) => {
                useProjectStore.getState().loadFromDB();
              });
            }
          } catch (e) {
            console.warn("[Store] 运行期内容核对未完成（不影响使用）:", e);
          }
        })();

        try {
          MessageStorage.onSessionMessagesReady(sessionId, () => {
            const again = MessageStorage.listMessages(sessionId);
            if (again.length > 0) {
              applyIfStillLoaded(again);
              console.log(`[Store] 消息镜像就绪后重读：sessionId=${sessionId} → ${again.length} 条`);
            }
          });
        } catch {
          /* 订阅失败保持空列表（与既有行为一致） */
        }
      }
    } catch (e) {
      console.error("[Store] loadMessages failed:", e);
      /*
       * P0-1：失败分支也要写**与 `messages: []` 一致的事实** ——
       * 这里把列表清空了，归属就必须一起清掉。留着旧的 `loadedSessionId`
       * 会让 `saveMessages` 认为"这份空列表属于 A"，于是把一个空列表写进 A
       * （无害但语义错），更糟的是掩盖"当前会话根本没加载"这个真实状态。
       */
      set({ messages: [], loadedSessionId: null, hasMoreMessages: false, isLoadingMore: false });
    }
  },

  loadMoreMessages: (sessionId, count = 10) => {
    try {
      const currentMessages = get().messages;
      if (currentMessages.length === 0 || get().isLoadingMore) return;
      
      set({ isLoadingMore: true });
      
      // Small delay so the loading indicator is visible
      setTimeout(() => {
        /**
         * **P0-2：这个 300ms 回调必须先校验归属。**
         *
         * 触发点是 `ChatPanel` 的滚动到底（`loadMoreMessages(currentSession?.id, 20)`），
         * 而 300ms 之后用户完全可能已经切到别的会话。此时 `get().messages` 是**新会话**的列表，
         * 而这里的 `currentMessages` / `sessionId` 还是**旧会话**的 ——
         * 原实现直接 `set({ messages: [...newBatch, ...s.messages] })`，等于把
         * **旧会话的历史拼进新会话的列表**（跨会话污染），并且新会话的 `hasMoreMessages`
         * 被写成旧会话的真值。
         *
         * 守卫放在 store 内（调用点 `ChatPanel.tsx` 不改）：归属不一致就丢弃这次翻页，
         * 但**必须**把 `isLoadingMore` 归 false —— 否则 `loadMoreMessages` 开头那句
         * `if (get().isLoadingMore) return` 会让翻页永久卡死（界面上的"加载中"再也下不来）。
         */
        if (get().loadedSessionId !== sessionId) {
          set({ isLoadingMore: false });
          return;
        }
        const allMessages = MessageStorage.listMessages(sessionId);
        const currentOldestTimestamp = currentMessages[0].timestamp;
        const olderMessages = allMessages.filter(m => m.timestamp < currentOldestTimestamp);
        
        if (olderMessages.length === 0) {
          set({ hasMoreMessages: false, isLoadingMore: false });
          return;
        }
        
        const newBatch = olderMessages.length > count 
          ? olderMessages.slice(olderMessages.length - count) 
          : olderMessages;
        
        set((s) => ({ 
          messages: [...newBatch, ...s.messages],
          hasMoreMessages: olderMessages.length > count,
          isLoadingMore: false,
        }));
      }, 300);
    } catch (e) {
      console.error("[Store] loadMoreMessages failed:", e);
      set({ isLoadingMore: false });
    }
  },

  saveMessages: (sessionId, explicit) => {
    // Defense-in-depth: skip auto-save while compaction is mutating the DB.
    // The agentic-loop sets this flag during its synchronous DB commit block
    // to prevent UI auto-save from interleaving db.run calls that corrupt
    // sql.js state ("bad parameter or other API misuse").
    if (isCompactionInProgress()) {
      console.log("[Store] saveMessages skipped — compaction in progress");
      return;
    }
    /**
     * 第 90 波（用户现场）：`saveMessages` 原来把失败只打成一行 `[Store] saveMessages failed:`
     * 就结束 —— 而数据库已经崩了（`RuntimeError: memory access out of bounds`）时，
     * 这段代码会被 AutoSave / 每轮循环反复调用，每次都在已崩的 WASM 堆上再撞一次：
     * 日志刷屏 + 不知道"消息到底存没存下来"。
     * 现在：致命状态直接跳过并**走统一失败上报**（界面能看见），普通失败也如实上报。
     */
    if (storageUnavailable()) {
      if (!warnedSaveMessagesFatal) {
        warnedSaveMessagesFatal = true;
        reportPersistFailure("store.saveMessages", new Error("本进程没有可用存储（端口未注册）"), "本次运行内不再尝试写入（请重启应用，界面已尝试抢救当前会话）");
      }
      return;
    }
    /**
     * ===== P0-1：**选哪一份消息来写**（跨会话污染的入口就是这一步） =====
     *
     * - 给了 `explicit`：以它为准，不碰 `get().messages`。
     *   这是**后台会话唯一正确的落库入口** —— `runAgenticLoop` 正在跑的会话用户已经切走时，
     *   `get().messages` 属于**别的**会话，写它就是把别的会话的消息写进 `sessionId`。
     * - 没给：写 `get().messages`，但**先校验归属**（见下）。
     */
    let msgs: Message[];
    if (explicit) {
      msgs = explicit;
    } else {
      /**
       * 归属校验：`loadedSessionId` 是"当前这份 `messages` 属于谁"的**事实**。
       *
       * 不一致时**拒绝**，并且是"拒绝 + 如实上报"两条一起 ——
       * 静默拒绝会让"消息没保存"这件事完全不可见（用户切回来发现这轮对话没了，
       * 日志里一片安静），照写则正是那个 P0 缺陷本身（把 A 的消息追加进 B 的权威日志，
       * 读路径还会把它显示出来）。
       *
       * `loadedSessionId === null` 时**不拒绝**：那表示"当前加载的列表未知"
       * （尚未 loadMessages / 已被 clearMessages 清空）。既有调用点里
       * `saveMessages(x)` 的语义就是"当前列表"，此时无从判定串号，按原语义照写；
       * 真正会出事的形态（已加载 A 却写 B）一定会命中上面的不等分支。
       */
      const loaded = get().loadedSessionId;
      if (loaded !== null && loaded !== sessionId) {
        reportPersistFailure(
          "store.saveMessages",
          new Error(
            `消息列表归属不一致：当前加载的是会话 ${loaded} 的消息，却被要求写入会话 ${sessionId}`,
          ),
          `已拒绝把会话 ${loaded} 的消息写进会话 ${sessionId}（跨会话写入已拦截，消息未保存）；后台会话请传 explicit 消息列表`,
        );
        return;
      }
      msgs = get().messages;
    }
    try {
      /**
       * 第 91 波：**只写变化过的消息**（见 messageFingerprint 的说明）。
       * `skipped` 数量进诊断日志 —— 长会话下它应该是绝大多数。
       */
      let seen = persistedFingerprints.get(sessionId);
      if (!seen) {
        seen = new Map<string, string>();
        persistedFingerprints.set(sessionId, seen);
      }
      let written = 0;
      let skipped = 0;
      for (const msg of msgs) {
        const fp = messageFingerprint(msg);
        if (seen.get(msg.id) === fp) {
          skipped++;
          continue;
        }
        // createMessage handles dedup internally: new messages get INSERT + event log append,
        // existing messages get UPDATE only (no duplicate event).
        MessageStorage.createMessage(msg, sessionId);
        seen.set(msg.id, fp);
        written++;
      }
      if (skipped > 0) {
        console.debug(`[Store] saveMessages: 写入 ${written} 条，跳过未变化 ${skipped} 条（会话 ${sessionId}）`);
      }
    } catch (e) {
      // 第 18 轮：`noteDatabaseError` 的"是否致命"分类随旧引擎删除；
      // 一次性提示 / 限流的职责由上面的 storageUnavailable() 守卫承担。
      console.error("[Store] saveMessages failed:", e);
      reportPersistFailure("store.saveMessages", e, "消息未能保存");
    }
  },

  removeGeneratedFiles: (messageId, files) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? { ...m, generatedFiles: (m.generatedFiles || []).filter((f) => !files.includes(f)) }
          : m
      ),
    }));
  },

  setStepProgress: (progress) => set({ stepProgress: progress }),
  setAgentActivities: (activities) => set({ agentActivities: activities }),
  addAgentActivity: (activity) => set((s) => ({ agentActivities: [...s.agentActivities, activity] })),
  updateAgentActivity: (id, update) => set((s) => ({ agentActivities: s.agentActivities.map((a) => a.id === id ? { ...a, ...update } : a) })),
  clearAgentActivities: () => set({ agentActivities: [], streamStartTime: null }),
  setStreamStartTime: (time) => set({ streamStartTime: time }),
  setLLMStatus: (status) => set({ llmStatus: status }),
  setDisplayMode: (mode) => set({ displayMode: mode }),
  addGuidanceMessage: (msg) => set((s) => ({ guidanceMessages: [...s.guidanceMessages, msg] })),
  markGuidanceConsumed: (id) => set((s) => ({
    guidanceMessages: s.guidanceMessages.map((g) => g.id === id ? { ...g, consumed: true } : g),
  })),
  removeGuidanceMessage: (id) => set((s) => ({
    guidanceMessages: s.guidanceMessages.filter((g) => g.id !== id),
  })),
  clearGuidanceMessages: () => set({ guidanceMessages: [] }),

  setFeedback: (messageId, feedback, sessionId) => {
    /*
     * 第 44 轮：**收敛成单一写者**。
     *
     * 原来这里同时发两条写：
     * ① `MessageStorage.saveFeedback`（`feedback.set`，**5 列**，实现是"先 DELETE 再 INSERT"）；
     * ② `putMessageFeedback`（域写，**9 列**）。
     *
     * 三条实测后果（真 CLI 取证）：
     * - ①会**抹掉** ②写的 `note / version / created_at / updated_at`（5 列 INSERT 不覆盖这四列 → NULL）；
     * - ②的返回值被 `catch { /* non-critical *\/ }` 吞掉 —— 失败对调用方完全不可见；
     * - 取消反馈时传 `"neutral"`，而表上有 `CHECK (feedback IN ('like','dislike'))` →
     *   真 CLI 实测 `参数 feedback 不合法：只允许 like / dislike（或 null 取消），收到 neutral`，
     *   也就是说"点取消反馈"从来没成功过（界面上的图标只是先被内存状态点亮了）。
     *
     * 现在只留**域写**这一条（9 列是 5 列的超集），并且：
     * - `neutral` 由 `putMessageFeedback` 归一成**删除那一行**（取消反馈的正确语义）；
     * - `ifVersion` 不传 = **不校验版本**（`feedback.ts` 的 `checkVersion` 已按此实现）；
     * - 失败**如实上报**，不再吞。
     */
    if (sessionId) {
      try {
        const res = putMessageFeedback(
          sessionId,
          messageId,
          feedback === "like" ? "like" : feedback === "dislike" ? "dislike" : "neutral",
        );
        if (!res.ok) {
          reportPersistFailure(
            "store.setFeedback",
            new Error(res.error || "写未被接受"),
            "消息反馈未保存（重启后会丢失）",
          );
        }
      } catch (e) {
        reportPersistFailure("store.setFeedback", e, "消息反馈未保存（重启后会丢失）");
      }
    }
    // Update in-memory state
    set((s) => {
      const newFeedback = { ...s.feedback };
      if (feedback === null) {
        delete newFeedback[messageId];
      } else {
        newFeedback[messageId] = feedback;
      }
      return { feedback: newFeedback };
    });
  },

  loadFeedback: (messageId) => {
    try {
      const fb = MessageStorage.loadFeedback(messageId);
      if (fb) {
        set((s) => ({ feedback: { ...s.feedback, [messageId]: fb } }));
      }
    } catch (e) {
      console.warn("[loadFeedback] Failed:", e);
    }
  },

  removeMessagesAfter: (messageId, includeSelf) => {
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return s;
      const keepCount = includeSelf ? idx : idx + 1;
      // P0 fix: also clean up feedback entries for removed messages
      const removedMessages = s.messages.slice(keepCount);
      if (removedMessages.length === 0) {
        return { messages: s.messages.slice(0, keepCount) };
      }
      const newFeedback = { ...s.feedback };
      for (const msg of removedMessages) {
        delete newFeedback[msg.id];
      }
      return { messages: s.messages.slice(0, keepCount), feedback: newFeedback };
    });
  },

  setScrollPosition: (pos) => set((s) => {
    // When user scrolls to bottom, clear unread flag
    if (pos === "bottom" || pos === "near-bottom") {
      return { scrollPosition: pos, hasUnreadMessages: false };
    }
    return { scrollPosition: pos };
  }),

  setHasUnreadMessages: (v) => set({ hasUnreadMessages: v }),
}));
