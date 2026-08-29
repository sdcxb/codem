/**
 * ShopPanel — 商店买卖面板
 * 使用 Kenney CC0 PNG 图标，零 emoji
 */

import { useState } from "react";
import type { GameEngine } from "../engine/GameEngine";
import cardsData from "../data/cards.json";
import toolsData from "../data/tools.json";
import { getCardIcon, getCardIconUrl, getToolIcon, getToolIconUrl } from "../utils/asset-maps";
import { UI_ICONS } from "../utils/asset-maps";

interface Props {
  engine: GameEngine;
  onClose: () => void;
}

export function ShopPanel({ engine, onClose }: Props) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [message, setMessage] = useState("");

  const shop = engine.getShopSystem();
  const shopItems = shop.getShopItems();
  const player = engine.getCurrentPlayer();

  const handleBuyCard = (cardId: number) => {
    const result = engine.shopBuyCard(cardId);
    setMessage(result.message);
  };

  const handleBuyTool = (toolId: number) => {
    const result = engine.shopBuyTool(toolId);
    setMessage(result.message);
  };

  const handleSellCard = (cardId: number) => {
    const result = engine.shopSellCard(cardId);
    setMessage(result.message);
  };

  const handleSellTool = (toolId: number) => {
    const result = engine.shopSellTool(toolId);
    setMessage(result.message);
  };

  return (
    <div className="card-panel-overlay" onClick={onClose}>
      <div className="shop-panel" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <h3>
            <img src={UI_ICONS.shop} alt="shop" className="panel-header-icon" />
            商店 — {player.name}
          </h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        <div className="shop-tabs">
          <button className={`shop-tab ${tab === "buy" ? "active" : ""}`} onClick={() => setTab("buy")}>
            购买
          </button>
          <button className={`shop-tab ${tab === "sell" ? "active" : ""}`} onClick={() => setTab("sell")}>
            出售
          </button>
        </div>

        <div className="shop-cash">
          <img src={UI_ICONS.cash} alt="cash" className="inline-icon" /> 现金: ¥{player.cash.toLocaleString()} | 点券: {player.points}
        </div>

        {message && <div className="action-message">{message}</div>}

        {tab === "buy" ? (
          <div className="shop-item-list">
            {shopItems.map(item => {
              const buyPrice = shop.getBuyPrice(item.basePrice);
              const stock = item.type === "card" ? shop.getCardStock(item.id) : shop.getToolStock(item.id);
              const icon = item.type === "card" ? getCardIcon(item.id) : getToolIcon(item.id);
              const iconUrl = item.type === "card" ? getCardIconUrl(item.id) : getToolIconUrl(item.id);
              return (
                <div key={`${item.type}-${item.id}`} className="shop-item">
                  <img src={iconUrl} alt={item.name} className="item-icon" style={{ borderColor: icon.color }} />
                  <div className="shop-item-info">
                    <span className="shop-item-name">{item.name}</span>
                    <span className="shop-item-desc">{item.description}</span>
                  </div>
                  <span className="shop-item-price">¥{buyPrice}</span>
                  <span className="shop-item-stock">库存:{stock}</span>
                  <button
                    onClick={() => item.type === "card" ? handleBuyCard(item.id) : handleBuyTool(item.id)}
                    disabled={stock <= 0 || player.cash < buyPrice}
                    className="shop-btn"
                  >
                    购买
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="shop-item-list">
            {player.cards.length > 0 && (
              <>
                <div className="sell-section-title">
                  <img src={UI_ICONS.cards} alt="cards" className="inline-icon" /> 卡牌
                </div>
                {player.cards.map((cardId, idx) => {
                  const card = cardsData[cardId];
                  if (!card) return null;
                  const icon = getCardIcon(cardId);
                  return (
                    <div key={`sell-card-${idx}`} className="shop-item">
                      <img src={getCardIconUrl(cardId)} alt={card.name} className="item-icon" style={{ borderColor: icon.color }} />
                      <div className="shop-item-info">
                        <span className="shop-item-name">{card.name}</span>
                        <span className="shop-item-desc">{card.description}</span>
                      </div>
                      <span className="shop-item-price">→{Math.floor(shop.getSellPrice(card.price))}点券</span>
                      <button onClick={() => handleSellCard(cardId)} className="shop-btn sell">出售</button>
                    </div>
                  );
                })}
              </>
            )}
            {player.tools.length > 0 && (
              <>
                <div className="sell-section-title">
                  <img src={UI_ICONS.tools} alt="tools" className="inline-icon" /> 道具
                </div>
                {player.tools.map((t, idx) => {
                  const tool = toolsData[t.id];
                  if (!tool) return null;
                  const icon = getToolIcon(t.id);
                  return (
                    <div key={`sell-tool-${idx}`} className="shop-item">
                      <img src={getToolIconUrl(t.id)} alt={tool.name} className="item-icon" style={{ borderColor: icon.color }} />
                      <div className="shop-item-info">
                        <span className="shop-item-name">{tool.name} ×{t.amount}</span>
                        <span className="shop-item-desc">{tool.description}</span>
                      </div>
                      <span className="shop-item-price">→{Math.floor(shop.getSellPrice(tool.price))}点券</span>
                      <button onClick={() => handleSellTool(t.id)} className="shop-btn sell">出售</button>
                    </div>
                  );
                })}
              </>
            )}
            {player.cards.length === 0 && player.tools.length === 0 && (
              <div className="empty-state">没有可出售的物品</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
