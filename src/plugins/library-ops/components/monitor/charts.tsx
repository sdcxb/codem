/**
 * 监控图表原语 —— 迷你折线 / 环形 / 热力图 / 条形 / 进度环。
 *
 * 全部为纯 SVG + CSS 变量实现，零图表库依赖；颜色只消费语义令牌
 * （`var(--accent)` / `var(--success)` / …），因此四套皮肤自动适配。
 *
 * 视觉语言对标 lobster-pet 的 `ActivityViz`（14 天热力图 + 会话类型环形图 +
 * 24 小时活跃时段柱状图）与 `TokenBar`。
 */

import { useMemo } from "react";
import type { SeriesPoint } from "../../types";

export interface SparklineProps {
  points: SeriesPoint[];
  /** 语义令牌名（如 "--accent"） */
  token?: string;
  width?: number;
  height?: number;
  /** 是否填充面积 */
  area?: boolean;
}

export function Sparkline({ points, token = "--accent", width = 120, height = 28, area = true }: SparklineProps) {
  const { line, fill } = useMemo(() => buildSparkline(points, width, height), [points, width, height]);
  const stroke = `var(${token})`;
  return (
    <svg className="lo-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {area && fill && <path d={fill} fill={stroke} opacity={0.16} />}
      {line && <path d={line} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}

function buildSparkline(points: SeriesPoint[], width: number, height: number): { line: string; fill: string } {
  if (!points || points.length < 2) return { line: "", fill: "" };
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const pad = 2;
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = height - pad - ((p.value - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const fill = `${line} L ${width} ${height} L 0 ${height} Z`;
  return { line, fill };
}

export interface DonutSlice {
  label: string;
  value: number;
  token: string;
}

export function DonutChart({ slices, size = 88, centerLabel }: { slices: DonutSlice[]; size?: number; centerLabel?: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  let cum = -90;
  const paths = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const angle = (s.value / (total || 1)) * 360;
      const start = cum;
      const end = cum + angle;
      cum = end;
      const p = arcPath(cx, cy, r, start, end);
      return { ...s, d: p, pct: total > 0 ? s.value / total : 0 };
    });

  return (
    <div className="lo-donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} className="lo-donut__track" />
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill={`var(${p.token})`} opacity={0.86} />
        ))}
        <circle cx={cx} cy={cy} r={r * 0.62} className="lo-donut__hole" />
        <text x={cx} y={cy - 1} className="lo-donut__value" textAnchor="middle">
          {centerLabel ?? total}
        </text>
        <text x={cx} y={cy + 10} className="lo-donut__unit" textAnchor="middle">
          总计
        </text>
      </svg>
      <div className="lo-donut__legend">
        {paths.map((p, i) => (
          <div key={i} className="lo-donut__legend-item">
            <span className="lo-donut__dot" style={{ background: `var(${p.token})` }} />
            <span className="lo-donut__legend-label">{p.label}</span>
            <span className="lo-donut__legend-value">{p.value}</span>
          </div>
        ))}
        {paths.length === 0 && <div className="lo-empty">暂无数据</div>}
      </div>
    </div>
  );
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  // 整圆退化处理：SVG 圆弧无法一次画满 360°
  if (endDeg - startDeg >= 359.999) {
    const mid = polar(cx, cy, r, startDeg + 180);
    return `M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${mid.x} ${mid.y} A ${r} ${r} 0 1 1 ${start.x} ${start.y} Z`;
  }
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export interface HeatmapProps {
  /** 每格一个值（按时间升序） */
  values: number[];
  /** 每格标题 */
  titles?: string[];
  /** 高亮格索引（如「今天」/「当前小时」） */
  highlightIndex?: number;
  token?: string;
  /** 每行格数（用于插入星期标签） */
  columns?: number;
}

export function Heatmap({ values, titles, highlightIndex = -1, token = "--accent", columns = 7 }: HeatmapProps) {
  const max = Math.max(1, ...values);
  return (
    <div className="lo-heatmap" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {values.map((v, i) => {
        const intensity = v / max;
        return (
          <div
            key={i}
            className={`lo-heatmap__cell${i === highlightIndex ? " is-now" : ""}`}
            title={titles?.[i] ?? `${v}`}
            style={
              v > 0
                ? { background: `color-mix(in srgb, var(${token}) ${Math.round(18 + intensity * 78)}%, transparent)` }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

export interface BarRowProps {
  label: string;
  value: number;
  max: number;
  token?: string;
  suffix?: string;
}

export function BarRow({ label, value, max, token = "--accent", suffix }: BarRowProps) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="lo-bar-row">
      <span className="lo-bar-row__label" title={label}>
        {label}
      </span>
      <span className="lo-bar-row__track">
        <span className="lo-bar-row__fill" style={{ width: `${pct}%`, background: `var(${token})` }} />
      </span>
      <span className="lo-bar-row__value">
        {value}
        {suffix ?? ""}
      </span>
    </div>
  );
}

export function ProgressRing({
  ratio,
  size = 46,
  token = "--accent",
  label,
}: {
  ratio: number;
  size?: number;
  token?: string;
  label?: string;
}) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="lo-ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="lo-ring__track" strokeWidth={4} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`var(${token})`}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={`${c * clamped} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x={size / 2} y={size / 2 + 4} className="lo-ring__text" textAnchor="middle">
          {Math.round(clamped * 100)}
        </text>
      </svg>
      {label && <span className="lo-ring__label">{label}</span>}
    </div>
  );
}

export function HourBars({
  values,
  token = "--accent",
  highlightIndex = -1,
}: {
  values: number[];
  token?: string;
  highlightIndex?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="lo-hourbars">
      {values.map((v, h) => (
        <div key={h} className={`lo-hourbars__col${h === highlightIndex ? " is-now" : ""}`} title={`${String(h).padStart(2, "0")}:00 — ${v}`}>
          <span
            className="lo-hourbars__bar"
            style={{ height: v > 0 ? `${Math.max(8, (v / max) * 100)}%` : "2px", background: `var(${token})` }}
          />
          {h % 3 === 0 && <span className="lo-hourbars__label">{h}</span>}
        </div>
      ))}
    </div>
  );
}
