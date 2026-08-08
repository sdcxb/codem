/**
 * QuickAccessCards — Agent 快速访问卡片
 *
 * 显示常用 Agent 卡片网格，支持点击切换、收藏、搜索过滤
 */

import { memo, useState, type ReactNode } from "react";
import { useLang, S } from "../core/i18n/lang";

interface Agent {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
}

interface QuickAccessCardsProps {
  /** Available agents */
  agents: Agent[];
  /** Favorite agent IDs */
  favoriteIds: Set<string>;
  /** When user selects an agent */
  onSelect: (agentId: string) => void;
  /** Toggle favorite */
  onToggleFavorite: (agentId: string) => void;
}

export const QuickAccessCards = memo(function QuickAccessCards({
  agents,
  favoriteIds,
  onSelect,
  onToggleFavorite,
}: QuickAccessCardsProps) {
  const lang = useLang();
  const [search, setSearch] = useState("");

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description.toLowerCase().includes(search.toLowerCase())
  );

  const favorites = filtered.filter((a) => favoriteIds.has(a.id));
  const others = filtered.filter((a) => !favoriteIds.has(a.id));

  const renderCard = (agent: Agent) => (
    <div key={agent.id} className="quick-access-card">
      <button className="card-favorite" onClick={() => onToggleFavorite(agent.id)}>
        {favoriteIds.has(agent.id) ? "★" : "☆"}
      </button>
      <button className="card-body" onClick={() => onSelect(agent.id)}>
        <div className="card-icon">{agent.icon}</div>
        <div className="card-name">{agent.name}</div>
        <div className="card-desc">{agent.description}</div>
      </button>
    </div>
  );

  return (
    <div className="quick-access-cards">
      <div className="quick-access-header">
        <h3>{S.quickAccess.title[lang]}</h3>
        <input
          type="text"
          className="quick-access-search"
          placeholder={S.quickAccess.search[lang]}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {favorites.length > 0 && (
        <div className="card-section">
          <h4>{S.quickAccess.favorites[lang]}</h4>
          <div className="card-grid">
            {favorites.map(renderCard)}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <div className="card-section">
          <h4>{S.quickAccess.allAgents[lang]}</h4>
          <div className="card-grid">
            {others.map(renderCard)}
          </div>
        </div>
      )}
    </div>
  );
});