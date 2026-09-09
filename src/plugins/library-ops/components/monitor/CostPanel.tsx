/**
 * CostPanel —— 用量 / 成本页（对标 lobster-pet `TokenBar` + 累计消耗卡）。
 *
 * 数据来自宿主 CostTracker 的真实 provider 上报（token 与成本同源），
 * 因此与「用量统计」面板口径一致。
 */

import type { LibrarySnapshot } from "../../types";
import { formatCost, formatPercent, formatTokens } from "../../core/format";
import { Card, Empty, Field, StatCard } from "./common";
import { DonutChart, Sparkline } from "./charts";

export interface CostPanelProps {
  snapshot: LibrarySnapshot | null;
  series: { tokens: Array<{ at: number; value: number }>; cost: Array<{ at: number; value: number }> };
  zh: boolean;
}

export function CostPanel({ snapshot, series, zh }: CostPanelProps) {
  if (!snapshot) return <Empty text={zh ? "等待采样…" : "Waiting…"} />;
  const m = snapshot.metrics;
  const total = m.tokensIn + m.tokensOut;
  const cachedRatio = total > 0 ? m.tokensCached / total : 0;

  const donut = [
    { label: zh ? "输入" : "Input", value: m.tokensIn, token: "--info" },
    { label: zh ? "输出" : "Output", value: m.tokensOut, token: "--warning" },
    { label: zh ? "缓存命中" : "Cached", value: m.tokensCached, token: "--success" },
  ];

  return (
    <div className="lo-cost">
      <div className="lo-kpi-grid">
        <StatCard label={zh ? "总 Token" : "Total tokens"} value={formatTokens(total)} token="--warning" points={series.tokens} />
        <StatCard label={zh ? "输入" : "Input"} value={formatTokens(m.tokensIn)} token="--info" />
        <StatCard label={zh ? "输出" : "Output"} value={formatTokens(m.tokensOut)} token="--accent-hover" />
        <StatCard label={zh ? "总成本" : "Total cost"} value={formatCost(m.costTotal)} token="--security-full" points={series.cost} />
        <StatCard label={zh ? "今日成本" : "Today"} value={formatCost(m.costToday)} token="--security-ask" />
        <StatCard
          label={zh ? "缓存命中率" : "Cache hit"}
          value={m.tokensCached > 0 ? formatPercent(cachedRatio, 1) : "—"}
          token="--success"
          hint={m.tokensCached > 0 ? undefined : zh ? "provider 未上报" : "not reported"}
        />
      </div>

      <div className="lo-cost__row">
        <Card title={zh ? "用量构成" : "Token split"} icon="🧮">
          <DonutChart slices={donut} size={104} />
        </Card>
        <Card title={zh ? "成本趋势" : "Cost trend"} icon="📈">
          <div className="lo-cost__chart">
            <Sparkline points={series.cost} token="--security-full" width={420} height={72} />
          </div>
          <div className="lo-fields">
            <Field label={zh ? "采样点数" : "Samples"}>{series.cost.length}</Field>
            <Field label={zh ? "本插件采样耗时" : "Sample time"}>{snapshot.sampleMs}ms</Field>
          </div>
          <p className="lo-note">
            {zh
              ? "成本口径与宿主「用量统计」一致（provider 上报优先，未上报时为 0，不做估算）。"
              : "Costs share the host usage-stats口径: provider-reported values only, no estimation."}
          </p>
        </Card>
      </div>
    </div>
  );
}
