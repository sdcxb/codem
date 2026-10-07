/**
 * `saveMessages` 的**成本账** ✓（第 45 波，目标② —— **先加留档、别先改逻辑** ✓，交接 §9 ✓）。
 *
 * ## 为什么（**量出来的嫌疑 ✓**）
 *
 * 用**不受背景行污染**的口径算过（`.preview-shot/_console-attribution.mjs` 的"按轮残差"段 ✓）：
 * ```
 * 轮间空档 3755s − 实测工具时间 2452s = ★ 残差 1303s（占会话跨度 21%）
 * 同期 saveMessages 2945 次 / 写入 11172 条   ⇒ 均 ≈442ms/次
 * ```
 * 而 `saveMessages` 的调用方是**流式 flush（每 100ms）** ✓ ⇒ 一条消息在一次流式回复里会被
 * 反复落库（正文每变一次就写一次完整快照 ✗）。
 *
 * ⚠️ ★ **442ms/次 是推出来的，不是量出来的** ✗ —— 所以这一步**只打点** ✓：
 * 记 `调用次数 / 落库条数 / 累计毫秒` ✓，由 `llm timing` 行取走 ✓（与 `msgw=` 同一手法 ✓）。
 * **先量到再动手** ✓ —— 本波已经因此否掉过一个假设（"逐 delta 写消息行" ✗，`msgw=0` ✓）。
 *
 * ★ 分层刻意如此 ✓：本模块在 `core/`、不含任何 UI 依赖 ⇒ **store（UI 层）与 agentic-loop（core）
 * 都能用同一份账** ✓，不必让 core 反向依赖 UI ✗。
 */
const stats = { calls: 0, msgs: 0, ms: 0, maxMs: 0 };

/** store 侧：记一批落库 ✓（`msgs` = **实际写下去的条数** ✓，不是遍历到的条数 ✓） */
export function noteSaveBatch(msgs: number, ms: number): void {
  stats.calls++;
  stats.msgs += Math.max(0, msgs);
  stats.ms += Math.max(0, ms);
  if (ms > stats.maxMs) stats.maxMs = ms;
}

/** 取走并清零 ✓（取走即清零 ⇒ 每个 `llm timing` 行报的是"这一段窗口的账" ✓） */
export function takeSaveStats(): { calls: number; msgs: number; ms: number; maxMs: number } {
  const out = { calls: stats.calls, msgs: stats.msgs, ms: Math.round(stats.ms), maxMs: Math.round(stats.maxMs) };
  stats.calls = 0;
  stats.msgs = 0;
  stats.ms = 0;
  stats.maxMs = 0;
  return out;
}

/** 仅供判据使用：清零 ✓ */
export function __resetSaveStatsForTests(): void {
  takeSaveStats();
}
