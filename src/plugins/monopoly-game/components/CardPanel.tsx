/**
 * CardPanel — 卡牌使用面板
 * 使用 Kenney CC0 PNG 图标，零 emoji
 */

import { useState } from "react";
import type { GameEngine } from "../engine/GameEngine";
import cardsData from "../data/cards.json";
import { getCardIcon, getCardIconUrl } from "../utils/asset-maps";
import { UI_ICONS } from "../utils/asset-maps";

interface Props {
  engine: GameEngine;
  currentPlayerId: number;
  onClose: () => void;
}

export function CardPanel({ engine, currentPlayerId, onClose }: Props) {
  const player = engine.getPlayers()[currentPlayerId];
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const [targetPlayer, setTargetPlayer] = useState<number>(0);
  const [message, setMessage] = useState("");

  if (!player) return null;

  const ownedCards = player.cards.map(cardId => cardsData[cardId]).filter(Boolean);
  const players = engine.getPlayers().filter(p => p.id !== currentPlayerId && p.status !== "bankrupted");

  const handleUse = () => {
    if (selectedCard === null) return;
    const card = cardsData[selectedCard];
    if (!card) return;

    const needsTarget = card.targetType === "other_player";
    const result = engine.useCard(selectedCard, needsTarget ? targetPlayer : undefined);
    setMessage(result.message);
    if (result.success) {
      setSelectedCard(null);
      setMessage(result.message);
    }
  };

  return (
    <div className="card-panel-overlay" onClick={onClose}>
      <div className="card-panel" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <h3>
            <img src={UI_ICONS.cards} alt="cards" className="panel-header-icon" />
            卡牌 ({ownedCards.length}/4)
          </h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        {ownedCards.length === 0 ? (
          <div className="empty-state">没有卡牌</div>
        ) : (
          <div className="card-list">
            {ownedCards.map((card, idx) => {
              const icon = getCardIcon(card.id);
              return (
                <div
                  key={idx}
                  className={`card-item ${selectedCard === card.id ? "selected" : ""}`}
                  onClick={() => setSelectedCard(card.id)}
                >
                  <div className="card-icon-row">
                    <img src={getCardIconUrl(card.id)} alt={card.name} className="item-icon" style={{ borderColor: icon.color }} />
                    <span className="card-name">{card.name}</span>
                  </div>
                  <div className="card-desc">{card.description}</div>
                </div>
              );
            })}
          </div>
        )}

        {selectedCard !== null && cardsData[selectedCard]?.targetType === "other_player" && (
          <div className="target-select">
            <label>选择目标:</label>
            <select value={targetPlayer} onChange={e => setTargetPlayer(parseInt(e.target.value))}>
              {players.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        {message && <div className="action-message">{message}</div>}

        <button
          className="action-btn primary"
          onClick={handleUse}
          disabled={selectedCard === null}
          style={{ marginTop: 8, width: "100%" }}
        >
          使用卡牌
        </button>
      </div>
    </div>
  );
}
