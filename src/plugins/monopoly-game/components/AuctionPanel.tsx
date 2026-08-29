/**
 * AuctionPanel — 拍卖竞价面板
 * 使用 Kenney CC0 PNG 图标，零 emoji
 */

import { useState } from "react";
import type { GameEngine } from "../engine/GameEngine";
import { UI_ICONS } from "../utils/asset-maps";

interface Props {
  engine: GameEngine;
  onClose: () => void;
}

export function AuctionPanel({ engine, onClose }: Props) {
  const [bidAmount, setBidAmount] = useState("");
  const [message, setMessage] = useState("");

  const auction = engine.getAuctionSystem();
  const state = auction.getState();
  const players = engine.getPlayers();

  if (!state) {
    return (
      <div className="card-panel-overlay" onClick={onClose}>
        <div className="shop-panel" onClick={e => e.stopPropagation()}>
          <p>没有进行中的拍卖</p>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    );
  }

  const handleBid = (playerId: number) => {
    const amt = parseInt(bidAmount) || 0;
    if (amt <= state.currentBid) {
      setMessage("出价必须高于 " + state.currentBid);
      return;
    }
    const result = engine.auctionBid(playerId, amt);
    setMessage(result.message);
    if (result.success) setBidAmount("");
  };

  const handlePass = (playerId: number) => {
    engine.auctionPass(playerId);
    engine.auctionAdvance();
    setMessage("已放弃竞价");
  };

  return (
    <div className="card-panel-overlay">
      <div className="shop-panel">
        <div className="panel-header">
          <h3>
            <img src={UI_ICONS.auction} alt="auction" className="panel-header-icon" />
            拍卖: {state.landName}
          </h3>
        </div>

        <div className="auction-info">
          <div className="stat-row"><span>起拍价</span><span>¥{state.basePrice.toLocaleString()}</span></div>
          <div className="stat-row"><span>当前最高价</span><span>¥{state.currentBid.toLocaleString()}</span></div>
          <div className="stat-row">
            <span>当前竞拍者</span>
            <span>{state.currentBidder !== null ? players[state.currentBidder]?.name || "玩家" + state.currentBidder : "无人"}</span>
          </div>
          <div className="stat-row"><span>第{state.round}轮 / {state.maxRounds}轮</span></div>
        </div>

        {message && <div className="action-message">{message}</div>}

        <div className="auction-participants">
          {state.participants.map(pid => {
            const p = players[pid];
            if (!p) return null;
            return (
              <div key={pid} className="auction-player">
                <div className="auction-player-info">
                  <span style={{ color: p.color }}>{p.name}</span>
                  <span className="auction-player-cash">¥{p.cash.toLocaleString()}</span>
                </div>
                <input
                  type="number"
                  placeholder={"高于" + state.currentBid}
                  value={bidAmount}
                  onChange={e => setBidAmount(e.target.value)}
                  className="auction-input"
                />
                <button onClick={() => handleBid(pid)} className="action-btn buy" disabled={!bidAmount}>
                  出价
                </button>
                <button onClick={() => handlePass(pid)} className="action-btn skip">
                  放弃
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
