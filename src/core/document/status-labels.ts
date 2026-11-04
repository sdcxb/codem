/**
 * 文档索引状态的**展示标签**（纯函数，便于判据直接断言）。
 *
 * 判据（DOCI-9）的核心是一条「不许骗人」的规则：
 * `needs_ocr` **不得**显示成「已索引」——它没有可检索文本，说成已索引会让模型
 * 得出「文档里没有这件事」的假结论。
 */

export interface DocStatusLike {
  status: string;
}

export interface DocBadge {
  label: string;
  tone: "ok" | "busy" | "warn" | "bad" | "muted";
  title: string;
}

/** 附件徽标。没有 document 行（未入索引）→ null。 */
export function docBadgeOf(doc?: DocStatusLike | null): DocBadge | null {
  if (!doc) return null;
  switch (doc.status) {
    case "ready":
      return { label: "已索引", tone: "ok", title: "已建立索引，可被检索" };
    case "pending":
    case "extracting":
    case "indexing":
      return { label: "索引中", tone: "busy", title: "正在提取/索引" };
    case "needs_ocr":
      return { label: "需 OCR", tone: "warn", title: "没有可提取文本（扫描件/图片），P1 接入视觉转录" };
    case "needs_engine":
      return { label: "需引擎", tone: "warn", title: "PDF 引擎未就绪" };
    case "needs_password":
      return { label: "需密码", tone: "warn", title: "PDF 已加密" };
    case "too_large":
      return { label: "过大", tone: "warn", title: "超过安全上限：只登记元数据" };
    case "stale":
      return { label: "已失效", tone: "warn", title: "原文件已移动/删除" };
    case "failed":
      return { label: "失败", tone: "bad", title: "索引失败（原因见 doc_status）" };
    case "unsupported":
      return { label: "不支持", tone: "muted", title: "该格式暂不支持索引" };
    default:
      return { label: doc.status, tone: "muted", title: doc.status };
  }
}

export interface DocStatusSummaryItem {
  key: string;
  label: string;
  count: number;
  tone: "ok" | "busy" | "warn" | "bad" | "muted";
}

/** 状态条摘要：只显示「有内容」的档位，顺序固定（进行中 → 已索引 → 需处理 → 失败）。 */
export function docIndexSummary(byStatus: Record<string, number>): DocStatusSummaryItem[] {
  const groups: Array<{ key: string; label: string; tone: DocStatusSummaryItem["tone"]; statuses: string[] }> = [
    { key: "running", label: "索引中", tone: "busy", statuses: ["pending", "extracting", "indexing"] },
    { key: "ready", label: "已索引", tone: "ok", statuses: ["ready"] },
    {
      key: "attention",
      label: "需处理",
      tone: "warn",
      statuses: ["needs_ocr", "needs_engine", "needs_password", "too_large", "stale"],
    },
    { key: "failed", label: "失败", tone: "bad", statuses: ["failed"] },
    { key: "unsupported", label: "不支持", tone: "muted", statuses: ["unsupported"] },
  ];
  return groups
    .map((group) => ({
      key: group.key,
      label: group.label,
      tone: group.tone,
      count: group.statuses.reduce((n, status) => n + (byStatus[status] ?? 0), 0),
    }))
    .filter((item) => item.count > 0);
}

export function docStageLabel(stage: string): string {
  switch (stage) {
    case "extracting":
      return "提取中";
    case "indexing":
      return "写入索引";
    case "ocr":
      return "视觉转录";
    case "cancelled":
      return "已取消";
    default:
      return stage;
  }
}
