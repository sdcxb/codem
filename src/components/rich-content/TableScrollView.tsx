/**
 * TableScrollView — 表格滚动视图
 *
 * 在 ContentFrame 内渲染可滚动的 Markdown 表格。
 * 支持水平滚动、排序指示。
 */

import { memo } from "react";
import { Table as TableIcon } from "lucide-react";
import { ContentFrame } from "./ContentFrame";

interface TableScrollViewProps {
  headers: string[];
  rows: string[][];
  title?: string;
}

export const TableScrollView = memo(function TableScrollView({
  headers,
  rows,
  title,
}: TableScrollViewProps) {
  return (
    <ContentFrame
      title={title || "表格"}
      badge={`${rows.length} 行 × ${headers.length} 列`}
      icon={<TableIcon size={14} />}
      className="table-scroll-view"
    >
      <div className="table-scroll-container">
        <table className="content-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ContentFrame>
  );
});
