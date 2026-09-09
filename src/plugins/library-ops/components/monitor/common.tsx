/**
 * 监控面板公共组件 —— 卡片 / KPI 卡 / 空态 / 标签 / 段落标题。
 *
 * 视觉语言与宿主一致：`.card` 的底色/描边/圆角（`--bg-secondary` /
 * `--border-primary` / 10px）、`.badge` 的标签形态、`--fs-*` 字号、
 * 图标统一走 `components/icons.tsx`（lucide-react），四套皮肤自动适配。
 */

import type { ReactNode } from "react";
import type { LoIconName, SeriesPoint } from "../../types";
import { LoIcon } from "../icons";
import { Sparkline } from "./charts";

export function Card({
  title,
  icon,
  actions,
  children,
  className = "",
  scroll = false,
  style,
}: {
  title?: ReactNode;
  icon?: LoIconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  scroll?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`lo-card ${className}`} style={style}>
      {(title || actions) && (
        <header className="lo-card__head">
          {icon && <LoIcon name={icon} size={14} className="lo-card__icon" />}
          {title && <span className="lo-card__title">{title}</span>}
          {actions && <span className="lo-card__actions">{actions}</span>}
        </header>
      )}
      <div className={scroll ? "lo-card__body lo-card__body--scroll" : "lo-card__body"}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  token = "--accent",
  points,
  trend,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  token?: string;
  points?: SeriesPoint[];
  trend?: number;
}) {
  return (
    <div className="lo-stat" style={{ ["--lo-stat-token" as string]: `var(${token})` }}>
      <div className="lo-stat__label">{label}</div>
      <div className="lo-stat__value">
        {value}
        {unit && <span className="lo-stat__unit">{unit}</span>}
        {trend !== undefined && trend !== 0 && (
          <span className={`lo-stat__trend${trend > 0 ? " is-up" : " is-down"}`}>
            <LoIcon name={trend > 0 ? "trending-up" : "trending-down"} size={12} />
            {Math.abs(Math.round(trend))}
          </span>
        )}
      </div>
      {points && points.length > 1 && (
        <div className="lo-stat__spark">
          <Sparkline points={points} token={token} width={140} height={26} />
        </div>
      )}
      {hint && <div className="lo-stat__hint">{hint}</div>}
    </div>
  );
}

export function Empty({ text = "暂无数据" }: { text?: string }) {
  return <div className="lo-empty">{text}</div>;
}

export function Pill({
  children,
  token = "--text-muted",
  title,
}: {
  children: ReactNode;
  token?: string;
  title?: string;
}) {
  return (
    <span className="lo-pill" style={{ ["--lo-pill-token" as string]: `var(${token})` }} title={title}>
      {children}
    </span>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="lo-section-title">
      <span>{children}</span>
      {hint && <span className="lo-section-title__hint">{hint}</span>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lo-field">
      <span className="lo-field__label">{label}</span>
      <span className="lo-field__value">{children}</span>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="lo-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="lo-switch__track" aria-hidden="true">
        <span className="lo-switch__thumb" />
      </span>
      <span className="lo-switch__label">{label}</span>
    </label>
  );
}
