/**
 * ToolPanel — 道具使用面板
 * 使用 Kenney CC0 PNG 图标，零 emoji
 */

import { useState } from "react";
import type { GameEngine } from "../engine/GameEngine";
import toolsData from "../data/tools.json";
import { getToolIcon, getToolIconUrl } from "../utils/asset-maps";
import { UI_ICONS } from "../utils/asset-maps";

interface Props {
  engine: GameEngine;
  currentPlayerId: number;
  onClose: () => void;
}

export function ToolPanel({ engine, currentPlayerId, onClose }: Props) {
  const player = engine.getPlayers()[currentPlayerId];
  const [selectedTool, setSelectedTool] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  if (!player) return null;

  const ownedTools = player.tools.map(t => ({
    ...t,
    def: toolsData[t.id],
  })).filter(t => t.def);

  const handleUse = () => {
    if (selectedTool === null) return;
    const result = engine.useToolItem(selectedTool);
    setMessage(result.message);
    if (result.success) {
      setSelectedTool(null);
    }
  };

  return (
    <div className="card-panel-overlay" onClick={onClose}>
      <div className="card-panel" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <h3>
            <img src={UI_ICONS.tools} alt="tools" className="panel-header-icon" />
            道具 ({ownedTools.reduce((s, t) => s + t.amount, 0)})
          </h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        {ownedTools.length === 0 ? (
          <div className="empty-state">没有道具</div>
        ) : (
          <div className="card-list">
            {ownedTools.map((t, idx) => {
              const icon = getToolIcon(t.id);
              return (
                <div
                  key={idx}
                  className={`card-item ${selectedTool === t.id ? "selected" : ""}`}
                  onClick={() => setSelectedTool(t.id)}
                >
                  <div className="card-icon-row">
                    <img src={getToolIconUrl(t.id)} alt={t.def.name} className="item-icon" style={{ borderColor: icon.color }} />
                    <span className="card-name">{t.def.name} <span className="tool-amount">×{t.amount}</span></span>
                  </div>
                  <div className="card-desc">{t.def.description}</div>
                </div>
              );
            })}
          </div>
        )}

        {message && <div className="action-message">{message}</div>}

        <button
          className="action-btn primary"
          onClick={handleUse}
          disabled={selectedTool === null}
          style={{ marginTop: 8, width: "100%" }}
        >
          使用道具
        </button>
      </div>
    </div>
  );
}
