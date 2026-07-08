import { useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface CloseConfirmDialogProps {
  onChoose: (action: "tray" | "close", remember: boolean) => void;
}

export function CloseConfirmDialog({ onChoose }: CloseConfirmDialogProps) {
  const lang = useLang();
  const [remember, setRemember] = useState(true);

  return (
    <div className="confirm-overlay">
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "420px" }}>
        <div className="confirm-title">{S.closeConfirm.title[lang]}</div>
        <div className="confirm-message" style={{ marginBottom: "16px" }}>
          {S.closeConfirm.message[lang]}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
          <button
            className="confirm-btn"
            style={{
              background: "var(--accent-primary)",
              color: "white",
              border: "none",
              padding: "10px 16px",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "2px",
            }}
            onClick={() => onChoose("tray", remember)}
          >
            <span style={{ fontWeight: 600 }}>{S.closeConfirm.tray[lang]}</span>
            <span style={{ fontSize: 11, opacity: 0.8 }}>{S.closeConfirm.trayDesc[lang]}</span>
          </button>

          <button
            className="confirm-btn"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              border: "none",
              padding: "10px 16px",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "2px",
            }}
            onClick={() => onChoose("close", remember)}
          >
            <span style={{ fontWeight: 600 }}>{S.closeConfirm.quit[lang]}</span>
            <span style={{ fontSize: 11, opacity: 0.7 }}>{S.closeConfirm.quitDesc[lang]}</span>
          </button>
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: 12,
            color: "var(--text-secondary)",
            cursor: "pointer",
            marginBottom: "4px",
          }}
        >
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          {S.closeConfirm.remember[lang]}
        </label>
      </div>
    </div>
  );
}
