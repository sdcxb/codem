/**
 * AssetsPanel — 资产面板 (G31)
 * 显示玩家全部资产清单：地产、股票、卡牌、道具
 */

import type { GameEngine } from "../engine/GameEngine";

interface Props {
  engine: GameEngine;
  playerId: number;
  onClose: () => void;
}

export function AssetsPanel({ engine, playerId, onClose }: Props) {
  const player = engine.getPlayers().find(p => p.id === playerId);
  if (!player) return null;

  const map = engine.getMap();
  const lands = player.properties.map(idx => {
    const land = engine.getProperty().getLand(idx);
    if (!land) return null;
    const toll = engine.getProperty().getToll(idx, 7, true);
    return {
      name: land.name,
      level: land.level || 0,
      maxLevel: land.maxLevel,
      landPrice: land.landPrice,
      buildPrice: land.buildPrice,
      toll,
      landValue: engine.getProperty().getLandValue(idx),
    };
  }).filter(Boolean);

  const stocks = engine.getPlayerStocks(playerId);
  const stockPrices = engine.getStockPrices();
  const stockNames = ["科技股份", "地产集团", "银行财团", "能源公司", "消费品牌", "医药集团", "基建工程", "娱乐传媒"];

  // 计算总资产
  const landValue = lands.reduce((sum, l) => sum + (l?.landValue || 0), 0);
  const stockValue = stocks.reduce((sum, s) => {
    const price = stockPrices.find(sp => sp.id === s.stockId)?.price || 0;
    return sum + price * s.amount;
  }, 0);
  const totalWealth = player.cash + player.moneyInBank - player.loan + landValue + stockValue;

  return (
    <div className="card-panel-overlay">
      <div className="card-panel" style={{ width: 480, maxHeight: "85%", overflowY: "auto" }}>
        <div className="panel-header">
          <h3>资产清单 — {player.name}</h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        {/* 总资产概览 */}
        <div style={{ background: "rgba(241, 196, 15, 0.1)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "#bdc3c7" }}>现金</span>
            <span style={{ color: "#ecf0f1" }}>¥{player.cash.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "#bdc3c7" }}>存款</span>
            <span style={{ color: "#ecf0f1" }}>¥{player.moneyInBank.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "#bdc3c7" }}>贷款</span>
            <span style={{ color: "#e74c3c" }}>-¥{player.loan.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "#bdc3c7" }}>地产价值</span>
            <span style={{ color: "#27ae60" }}>¥{landValue.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "#bdc3c7" }}>股票市值</span>
            <span style={{ color: "#27ae60" }}>¥{stockValue.toLocaleString()}</span>
          </div>
          <div style={{ borderTop: "1px solid #34495e", marginTop: 4, paddingTop: 4, display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#f1c40f", fontWeight: "bold" }}>总资产</span>
            <span style={{ color: "#f1c40f", fontWeight: "bold", fontSize: 16 }}>¥{totalWealth.toLocaleString()}</span>
          </div>
        </div>

        {/* 地产清单 */}
        <div className="sell-section-title">地产 ({lands.length})</div>
        {lands.length === 0 ? (
          <div className="empty-state">无地产</div>
        ) : (
          <div className="card-list">
            {lands.map((l, i) => (
              <div key={i} className="shop-item">
                <div className="shop-item-info">
                  <span className="shop-item-name">{l!.name}</span>
                  <span className="shop-item-desc">Lv.{l!.level}/{l!.maxLevel} · 买价¥{l!.landPrice.toLocaleString()} · 过路费¥{l!.toll.toLocaleString()}</span>
                </div>
                <span className="shop-item-price">¥{l!.landValue.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        {/* 股票清单 */}
        <div className="sell-section-title">股票 ({stocks.length})</div>
        {stocks.length === 0 ? (
          <div className="empty-state">无股票</div>
        ) : (
          <div className="card-list">
            {stocks.map((s, i) => {
              const price = stockPrices.find(sp => sp.id === s.stockId)?.price || 0;
              const value = price * s.amount;
              const profit = (price - s.avgCost) * s.amount;
              return (
                <div key={i} className="shop-item">
                  <div className="shop-item-info">
                    <span className="shop-item-name">{stockNames[s.stockId] || `股票${s.stockId}`}</span>
                    <span className="shop-item-desc">{s.amount}股 · 均价¥{s.avgCost} · 现价¥{price}</span>
                  </div>
                  <span className="shop-item-price" style={{ color: profit >= 0 ? "#27ae60" : "#e74c3c" }}>
                    ¥{value.toLocaleString()}
                    <br /><span style={{ fontSize: 10 }}>{profit >= 0 ? "+" : ""}{profit.toLocaleString()}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* 卡牌 */}
        <div className="sell-section-title">卡牌 ({player.cards.length})</div>
        <div className="extra-row" style={{ color: "#95a5a6", fontSize: 11 }}>
          {player.cards.length > 0 ? `持有 ${player.cards.length} 张卡牌` : "无卡牌"}
        </div>

        {/* 道具 */}
        <div className="sell-section-title">道具 ({player.tools.reduce((s, t) => s + t.amount, 0)})</div>
        <div className="extra-row" style={{ color: "#95a5a6", fontSize: 11 }}>
          {player.tools.length > 0 ? player.tools.map(t => `道具${t.id}×${t.amount}`).join(", ") : "无道具"}
        </div>
      </div>
    </div>
  );
}
