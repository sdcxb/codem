/**
 * useSessionAutosave —— 消息自动保存（**订阅驱动**，第 6 轮从 App 的 effect 里搬出来）。
 *
 * ## 为什么要搬
 *
 * 原实现是 App 里的一个 `useEffect`，依赖 `[messages, isStreaming, loadedSessionId]`。
 * 这在语义上没问题，但它让 **App 必须订阅 `messages`** —— 于是流式期间每 100ms 一次
 * `appendToMessage` 都会让 6500 行的 App（以及它渲染的 TitleBar / Sidebar / RightSidebar /
 * ChatPanel 四棵子树）重渲染一次。自动保存本身**不需要重渲染**：它只是"看到变化就写库"。
 *
 * 所以把它改成 store 订阅：变化在订阅回调里处理，App 不再需要 `messages` 这个字段。
 *
 * ## 语义（与搬家前逐条一致，判据见 `session-autosave.test.tsx`）
 *
 * 1. **归属** = `loadedSessionId`（不是 `currentSession.id`）—— 笔记本回合期间写的是笔记本会话；
 * 2. 没有归属、或消息为空 ⇒ 不写；
 * 3. `isStreaming` ⇒ **2 秒防抖**（每来一条就重置计时器，避免每 100ms 写一次库）；
 * 4. 非流式 ⇒ **立即写**（回合结束、编辑、删除都会走到这里）；
 * 5. `messages` / `isStreaming` / `loadedSessionId` 任一变化都重新评估（与原来的依赖数组一致）；
 * 6. 卸载时清掉未触发的计时器（原 effect 的 cleanup 同义）。
 *
 * ⚠️ 第 5 条里 `loadedSessionId` 变化时写的是**新**归属 —— 这与原实现逐字一致
 * （旧会话由 App 里"切会话前保存"那条 effect 负责，见 `App.tsx` 的 `currentSession?.id` 依赖）。
 */

import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { debugLog } from "../core/debug";

interface AutosaveSnapshot {
  messages: unknown;
  isStreaming: boolean;
  owner: string | null;
}

export function useSessionAutosave(saveMessages: (sessionId: string) => void): void {
  const saveRef = useRef(saveMessages);
  saveRef.current = saveMessages;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRef = useRef<AutosaveSnapshot | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const run = (snapshot: AutosaveSnapshot) => {
      const owner = snapshot.owner;
      const count = Array.isArray(snapshot.messages) ? snapshot.messages.length : 0;
      if (!owner || count === 0) return;
      if (snapshot.isStreaming) {
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          debugLog("autosave", `Debounce save: ${count} messages to ${owner}`);
          saveRef.current(owner);
        }, 2000);
        return;
      }
      clearTimer();
      debugLog("autosave", `Immediate save: ${count} messages to ${owner}`);
      saveRef.current(owner);
    };

    const initial = useAppStore.getState();
    lastRef.current = {
      messages: initial.messages,
      isStreaming: initial.isStreaming,
      owner: initial.loadedSessionId,
    };
    /* 与原 effect 一致：挂载时先按当前状态评估一次（通常没有消息，等于 no-op） */
    run({ messages: initial.messages, isStreaming: initial.isStreaming, owner: initial.loadedSessionId });

    const unsubscribe = useAppStore.subscribe((next) => {
      const prev = lastRef.current;
      if (
        prev &&
        next.messages === prev.messages &&
        next.isStreaming === prev.isStreaming &&
        next.loadedSessionId === prev.owner
      ) {
        return;
      }
      lastRef.current = {
        messages: next.messages,
        isStreaming: next.isStreaming,
        owner: next.loadedSessionId,
      };
      run({ messages: next.messages, isStreaming: next.isStreaming, owner: next.loadedSessionId });
    });

    return () => {
      unsubscribe();
      clearTimer();
    };
  }, []);
}
