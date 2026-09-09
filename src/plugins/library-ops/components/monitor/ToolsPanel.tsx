/**
 * ToolsPanel —— 工具活动页。
 *
 * 从快照事件的工具类事件中聚合「工具调用频次 + 失败次数」，
 * 并列出最近调用流水（对标 lobster-pet 的日志/事件密度视图）。
 */

import { useMemo } from "react";
import type { LibrarySnapshot } from "../../types";
import { toolToActivity } from "../../core/telemetry-adapter";
import { ACTIVITY_META } from "../../types";
import { Card, Empty, Field, Pill, SectionTitle } from "./common";
import { BarRow } from "./charts";
import { clockOf, severityLabel, severityToken } from "./labels";

export interface ToolsPanelProps {
  snapshot: LibrarySnapshot | null;
  zh: boolean;
}

export function ToolsPanel({ snapshot, zh }: ToolsPanelProps) {
  const agg = useMemo(() => {
    if (!snapshot) return { counts: [] as Array<{ tool: string; count: number; errors: number }>, total: 0, errors: 0 };
    const map = new Map<string, { count: number; errors: number }>();
    for (const e of snapshot.events) {
      if (e.kind !== "tool") continue;
      const tool = e.text.split(" ")[0] ?? e.text;
      const cur = map.get(tool) ?? { count: 0, errors: 0 };
      cur.count++;
      if (e.severity === "bad") cur.errors++;
      map.set(tool, cur);
    }
    const counts = [...map.entries()]
      .map(([tool, v]) => ({ tool, ...v }))
      .sort((a, b) => b.count - a.count);
    return { counts, total: counts.reduce((s, x) => s + x.count, 0), errors: counts.reduce((s, x) => s + x.errors, 0) };
  }, [snapshot]);

  if (!snapshot) return <Empty text={zh ? "等待采样…" : "Waiting…"} />;

  const max = Math.max(1, ...agg.counts.map((c) => c.count));
  const toolEvents = snapshot.events.filter((e) => e.kind === "tool").slice(0, 40);

  return (
    <div className="lo-tools">
      <Card title={zh ? "工具调用分布" : "Tool distribution"} icon="🔧" className="lo-card--tools">
        <div className="lo-fields">
          <Field label={zh ? "最近调用" : "Recent calls"}>{agg.total}</Field>
          <Field label={zh ? "失败" : "Failed"}>
            <span style={{ color: agg.errors > 0 ? "var(--error)" : "var(--text-secondary)" }}>{agg.errors}</span>
          </Field>
          <Field label={zh ? "不同工具" : "Distinct tools"}>{agg.counts.length}</Field>
        </div>
        <SectionTitle>{zh ? "频次排行" : "By frequency"}</SectionTitle>
        {agg.counts.length === 0 ? (
          <Empty text={zh ? "最近没有工具调用" : "No recent tool calls"} />
        ) : (
          <div className="lo-bars">
            {agg.counts.slice(0, 14).map((c) => (
              <BarRow
                key={c.tool}
                label={c.tool}
                value={c.count}
                max={max}
                token={c.errors > 0 ? "--error" : `--${activityTokenFor(c.tool)}`}
                suffix={c.errors > 0 ? ` (${c.errors}✗)` : ""}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title={zh ? "调用流水" : "Call stream"} icon="📜" scroll className="lo-card--stream">
        {toolEvents.length === 0 ? (
          <Empty text={zh ? "暂无流水" : "No stream"} />
        ) : (
          <ul className="lo-stream">
            {toolEvents.map((e) => (
              <li key={e.id} className="lo-stream__item" data-severity={e.severity}>
                <span className="lo-stream__time">{clockOf(e.at)}</span>
                <span className="lo-stream__text" title={e.text}>
                  {e.text}
                </span>
                <Pill token={severityToken(e.severity)}>{severityLabel(e.severity, zh)}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function activityTokenFor(tool: string): string {
  const act = toolToActivity(tool);
  return ACTIVITY_META[act].token.replace(/^--/, "");
}
