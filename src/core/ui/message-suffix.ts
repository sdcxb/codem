/**
 * 「这条 assistant 之后还有没有 assistant」的**一次后缀扫描**（第 233 轮审计 · P1 流式卡顿）。
 *
 * ## 缺陷形态
 *
 * `ChatPanel` 在**渲染体**里对每一条 assistant 行都做
 *
 * ```tsx
 * const isLatestMessage =
 *   msg.role === "assistant" &&
 *   !displayMessages.slice(effectiveIdx + 1).some((m) => m.role === "assistant");
 * ```
 *
 * `slice` 复制尾数组 + `some` 扫描 ⇒ 单行 O(n)、整列 **O(n²)**，而且这段代码在
 * **每次渲染**都跑 —— 流式期间每 100ms 一次 flush，1000 行会话就是每 flush
 * 50 万次元素搬运（实测 1000 行 ≈ 8–12ms 纯浪费，还把主线程占住让流式更抖）。
 *
 * ## 修法
 *
 * 从尾部走**一遍**，把"i 之后有没有 assistant"存成布尔数组：
 * `hasAfter[n] = false`、`hasAfter[i] = hasAfter[i+1] || messages[i].role === "assistant"`。
 * 于是任意一行 O(1) 查询，整列 O(n)。
 *
 * 判据见 `src/test/chat-streaming-suffix.test.ts`（正确性 + 规模 + 反向对照）。
 */
export interface RoleBearing {
  role: string;
}

/**
 * 返回 `hasAfter`：长度为 `messages.length + 1`。
 * `hasAfter[i]` = 下标 `i` **之后**（不含 i）是否还存在 role === "assistant" 的消息。
 */
export function computeHasAssistantAfter(messages: readonly RoleBearing[]): boolean[] {
  const n = messages.length;
  const hasAfter = new Array<boolean>(n + 1).fill(false);
  // 从尾部走一遍：`hasAfter[i]` = 「下标 i+1 是 assistant」或「i+1 之后还有 assistant」
  for (let i = n - 1; i >= 0; i--) {
    hasAfter[i] = (i + 1 < n && messages[i + 1].role === "assistant") || hasAfter[i + 1];
  }
  return hasAfter;
}
