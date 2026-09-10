/**
 * LibraryOpsUsageEmbed —— 贡献给宿主「任务管理 → 概览」页签的「用量」区块。
 *
 * 为什么放在概览（v1.15.1）：概览与「用量」本来就是同一件事的两种说法 ——
 * 概览给的是四张计数卡，用量给的是 KPI / 健康度 / 活动分布 / token 与成本。
 * 原先两块分处两个页签、还要靠一个跳转按钮来回指，属于重复入口；
 * 现在把「用量」整块迁进概览，插件的「用量」视图从看板里删除。
 *
 * 与宿主解耦：宿主只认 `task-center.overview` 这个 slot，不认识本插件；
 * 插件禁用 → 概览回退到宿主自带的「最近活动」预览，行为完整。
 *
 * 注意：这里**不渲染** `.lo-task` 外壳（那是宿主页签外壳），
 * 因此要自己起一个容器查询上下文 `.lo-embed`，插件里 `@container lo (...)` 的自适应规则才生效。
 */

import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { useLibraryOpsSampling } from "./LibraryOpsViewShell";
import { OverviewPanel } from "./monitor/OverviewPanel";
import { CostPanel } from "./monitor/CostPanel";

export function LibraryOpsUsageEmbed() {
  const zh = useLang() === "zh";
  const snapshot = useLibraryOps((s) => s.snapshot);
  const series = useLibraryOps((s) => s.series);
  const requestView = useLibraryOps((s) => s.requestView);

  // 概览页打开时也要采样（外壳不在场，自己起采样）
  useLibraryOpsSampling();

  return (
    <div className="lo-embed" data-lo-view="task-center-overview-usage">
      <div className="lo-embed__title">
        {zh ? "用量与活动" : "Usage & Activity"}
      </div>
      <div className="lo-usage">
        <OverviewPanel
          snapshot={snapshot}
          series={series}
          zh={zh}
          onOpenLibrary={() => requestView("scene")}
          onOpenTab={(v) => requestView(v)}
        />
        <CostPanel snapshot={snapshot} series={series} zh={zh} />
      </div>
    </div>
  );
}

export default LibraryOpsUsageEmbed;
