/**
 * BankPanel — 银行操作面板
 * 使用 Kenney CC0 PNG 图标，零 emoji
 */

import { useState } from "react";
import type { GameEngine } from "../engine/GameEngine";
import { UI_ICONS } from "../utils/asset-maps";

interface Props {
  engine: GameEngine;
  onClose: () => void;
}

export function BankPanel({ engine, onClose }: Props) {
  const [tab, setTab] = useState<"deposit" | "withdraw" | "loan" | "repay">("deposit");
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");

  const player = engine.getCurrentPlayer();

  const handleAction = () => {
    const amt = parseInt(amount) || 0;
    if (amt <= 0) { setMessage("请输入有效金额"); return; }

    let result;
    switch (tab) {
      case "deposit": result = engine.bankDeposit(amt); break;
      case "withdraw": result = engine.bankWithdraw(amt); break;
      case "loan": result = engine.bankLoan(amt); break;
      case "repay": result = engine.bankRepay(amt); break;
    }
    if (result) {
      setMessage(result.message);
      setAmount("");
    }
  };

  return (
    <div className="card-panel-overlay" onClick={onClose}>
      <div className="shop-panel" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <h3>
            <img src={UI_ICONS.bank} alt="bank" className="panel-header-icon" />
            银行 — {player.name}
          </h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        <div className="bank-info">
          <div className="stat-row"><span>现金</span><span>¥{player.cash.toLocaleString()}</span></div>
          <div className="stat-row"><span>存款</span><span>¥{player.moneyInBank.toLocaleString()}</span></div>
          <div className="stat-row"><span>贷款</span><span>¥{player.loan.toLocaleString()}</span></div>
        </div>

        <div className="bank-tabs">
          <button className={`shop-tab ${tab === "deposit" ? "active" : ""}`} onClick={() => setTab("deposit")}>存款</button>
          <button className={`shop-tab ${tab === "withdraw" ? "active" : ""}`} onClick={() => setTab("withdraw")}>取款</button>
          <button className={`shop-tab ${tab === "loan" ? "active" : ""}`} onClick={() => setTab("loan")}>贷款</button>
          <button className={`shop-tab ${tab === "repay" ? "active" : ""}`} onClick={() => setTab("repay")}>还款</button>
        </div>

        <div className="bank-input">
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="金额"
            style={{ flex: 1, padding: "6px 8px", borderRadius: 4, border: "1px solid #2c3e50", background: "#1a1a2e", color: "#ecf0f1" }}
          />
          <button onClick={handleAction} className="action-btn primary" style={{ marginLeft: 8 }}>确认</button>
        </div>

        <div className="quick-amounts">
          {[1000, 5000, 10000, 50000].map(v => (
            <button key={v} className="quick-btn" onClick={() => setAmount(String(v))}>¥{v.toLocaleString()}</button>
          ))}
        </div>

        {message && <div className="action-message">{message}</div>}
      </div>
    </div>
  );
}
