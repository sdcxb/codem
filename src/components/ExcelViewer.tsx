/**
 * ExcelViewer — Excel 文件查看器
 *
 * 简易展示 .xlsx/.csv 文件内容为表格。
 * 使用 SheetJS (xlsx) 进行解析。
 */

import { useState, useEffect, memo } from "react";
import { FileSpreadsheet, LoaderCircle } from "lucide-react";

interface ExcelViewerProps {
  filePath?: string;
  data?: ArrayBuffer;
  onClose?: () => void;
}

export const ExcelViewer = memo(function ExcelViewer({ filePath, data, onClose }: ExcelViewerProps) {
  const [sheets, setSheets] = useState<Array<{ name: string; rows: string[][] }>>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError("");
        let buffer: ArrayBuffer;
        if (data) {
          buffer = data;
        } else if (filePath) {
          const res = await fetch(`file://${filePath}`);
          buffer = await res.arrayBuffer();
        } else {
          setError("No file provided");
          return;
        }

        // Dynamic import xlsx
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        const sheetData = workbook.SheetNames.map(name => {
          const sheet = workbook.Sheets[name];
          const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
          return { name, rows: rows as string[][] };
        });

        if (!cancelled) {
          setSheets(sheetData);
          setActiveSheet(0);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Failed to load Excel file");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, data]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 48, gap: 8 }}>
        <LoaderCircle size={20} className="spinning" />
        <span>Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: "var(--error)", textAlign: "center" }}>
        <FileSpreadsheet size={32} style={{ marginBottom: 8 }} />
        <div>{error}</div>
      </div>
    );
  }

  const currentSheet = sheets[activeSheet];

  return (
    <div className="excel-viewer">
      {sheets.length > 1 && (
        <div className="excel-viewer-tabs" style={{ display: "flex", gap: 4, marginBottom: 8, borderBottom: "1px solid var(--border-primary)", paddingBottom: 4 }}>
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveSheet(i)}
              style={{
                padding: "4px 12px", fontSize: 12, cursor: "pointer",
                background: i === activeSheet ? "var(--accent)" : "transparent",
                color: i === activeSheet ? "#fff" : "var(--text-muted)",
                border: "none", borderRadius: 4,
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {currentSheet && currentSheet.rows.length > 0 ? (
        <div style={{ overflow: "auto", maxHeight: "60vh" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <tbody>
              {currentSheet.rows.slice(0, 500).map((row, ri) => (
                <tr key={ri} style={{ borderBottom: "1px solid var(--border-primary)" }}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "4px 8px",
                        borderRight: "1px solid var(--border-primary)",
                        whiteSpace: "nowrap",
                        fontWeight: ri === 0 ? 600 : 400,
                        background: ri === 0 ? "var(--bg-tertiary)" : "transparent",
                      }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {currentSheet.rows.length > 500 && (
            <div style={{ textAlign: "center", padding: 8, color: "var(--text-muted)", fontSize: 11 }}>
              Showing first 500 of {currentSheet.rows.length} rows
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>Empty sheet</div>
      )}
    </div>
  );
});
