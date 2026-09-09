/**
 * 展示格式化工具 —— 全插件共用的数值/时间格式化（保证同一指标在各面板口径一致）。
 */

/** token 计数：1.2M / 34.5k / 987 */
export function formatTokens(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return "0";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** 金额：$1.23 / <$0.01 */
export function formatCost(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}k`;
  return `$${v.toFixed(2)}`;
}

/** 相对时间：刚刚 / 3m / 2h / 5d */
export function formatAge(ms: number | null | undefined, now = Date.now()): string {
  const v = Number(ms ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const delta = Math.max(0, now - v);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

/** 百分比（0..1 → 0..100） */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  const v = Number(ratio ?? 0);
  if (!Number.isFinite(v)) return "0%";
  return `${(v * 100).toFixed(digits)}%`;
}

/** 短 id（面板展示） */
export function shortId(id: string | undefined, len = 8): string {
  if (!id) return "—";
  const s = String(id);
  return s.length <= len ? s : `${s.slice(0, len)}…`;
}

/** 本地时钟 HH:MM:SS */
export function formatClock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
