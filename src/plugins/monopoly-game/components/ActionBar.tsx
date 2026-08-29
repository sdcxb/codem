/**
 * ActionBar — 操作栏
 * 根据游戏阶段显示不同按钮，全部使用 Kenney CC0 PNG 图标
 * G26: 卖地按钮  G31: 资产面板  G34: 投降  G35: 音量  G36: 速度
 */

import type { GamePhase, PlayerState } from "../types";
import { UI_ICONS } from "../utils/asset-maps";

const ICON_BASE = new URL("../assets/sprites/icons/", import.meta.url).href;
const DICE_ICON_BASE = new URL("../assets/sprites/dice/", import.meta.url).href;

// 操作栏专用小图标（修正映射，使图标与功能匹配）
const ACTION_ICONS = {
  dice: DICE_ICON_BASE + "dice_1.png",      // Kenney 骰子图标 → 掷骰子
  buy: ICON_BASE + "home.png",              // 房屋图标 → 购买地块
  upgrade: ICON_BASE + "star.png",          // 星标图标 → 升级地产
  sell: ICON_BASE + "basket.png",            // 篮子图标 → 卖地
  skip: ICON_BASE + "cross.png",            // 叉号图标 → 跳过
  surrender: ICON_BASE + "door.png",        // 门图标 → 投降
  assets: ICON_BASE + "star.png",            // 星标图标 → 资产面板
  help: ICON_BASE + "question.png",          // 问号图标 → 帮助
  commercial: ICON_BASE + "home.png",        // 房屋图标 → 购买商业
  bank: UI_ICONS.bank,
  shop: UI_ICONS.shop,
  cards: UI_ICONS.cards,
  tools: UI_ICONS.tools,
  stock: UI_ICONS.stock,
  auction: UI_ICONS.auction,
};

interface Props {
  phase: GamePhase;
  currentPlayer?: PlayerState;
  onRollDice: () => void;
  onEndTurn: () => void;
  onBuyLand: () => void;
  onUpgradeLand: () => void;
  onSkip: () => void;
  onShowStock: () => void;
  onShowCards: () => void;
  onShowTools: () => void;
  onShowShop: () => void;
  onShowBank: () => void;
  onShowAuction: () => void;
  onShowSave: () => void;
  onShowLoad: () => void;
  // G26/G31/G34/G35/G36 新增
  onShowAssets: () => void;
  onShowSellLand: () => void;
  onBuyCommercial?: () => void;
  onSurrender: () => void;
  onShowHelp: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  gameSpeed: number;
  onSpeedChange: (s: number) => void;
}

export function ActionBar({
  phase,
  currentPlayer,
  onRollDice,
  onEndTurn,
  onBuyLand,
  onUpgradeLand,
  onSkip,
  onShowStock,
  onShowCards,
  onShowTools,
  onShowShop,
  onShowBank,
  onShowAuction,
  onShowSave,
  onShowLoad,
  onShowAssets,
  onShowSellLand,
  onBuyCommercial,
  onSurrender,
  onShowHelp,
  volume,
  onVolumeChange,
  gameSpeed,
  onSpeedChange,
}: Props) {
  return (
    <div className="action-bar">
      <div className="action-left">
        {phase === "rolling" && (
          <button className="action-btn primary" onClick={onRollDice}>
            <img src={ACTION_ICONS.dice} alt="dice" className="btn-icon" /> 掷骰子
          </button>
        )}
        {phase === "idle" && (
          <>
            <button className="action-btn buy" onClick={onBuyLand}>
              <img src={ACTION_ICONS.buy} alt="buy" className="btn-icon" /> 购买地块
            </button>
            <button className="action-btn upgrade" onClick={onUpgradeLand}>
              <img src={ACTION_ICONS.upgrade} alt="upgrade" className="btn-icon" /> 升级地产
            </button>
            {/* G26: 主动卖地 */}
            <button className="action-btn" style={{ background: "#d4a017", color: "white" }} onClick={onShowSellLand}>
              <img src={ACTION_ICONS.sell} alt="sell" className="btn-icon" /> 卖地
            </button>
            {/* G25: 购买商业地块 */}
            {onBuyCommercial && (
              <button className="action-btn" style={{ background: "#8e44ad", color: "white" }} onClick={onBuyCommercial}>
                <img src={ACTION_ICONS.commercial} alt="commercial" className="btn-icon" /> 购买
              </button>
            )}
            <button className="action-btn skip" onClick={onSkip}>
              <img src={ACTION_ICONS.skip} alt="skip" className="btn-icon" /> 跳过
            </button>
          </>
        )}
        {(phase === "bank" || phase === "shop" || phase === "magic" || phase === "auction" || phase === "fortune") && (
          <button className="action-btn skip" onClick={onSkip}>
            <img src={ACTION_ICONS.skip} alt="skip" className="btn-icon" /> 确认/跳过
          </button>
        )}
        {phase === "moving" && (
          <div className="moving-indicator">移动中...</div>
        )}
        {phase === "ended" && (
          <div className="moving-indicator" style={{ color: "#f1c40f" }}>游戏结束</div>
        )}
      </div>
      <div className="action-right">
        <button className="action-btn secondary" onClick={onShowBank}>
          <img src={ACTION_ICONS.bank} alt="bank" className="btn-icon" /> 银行
        </button>
        <button className="action-btn secondary" onClick={onShowShop}>
          <img src={ACTION_ICONS.shop} alt="shop" className="btn-icon" /> 商店
        </button>
        <button className="action-btn secondary" onClick={onShowCards}>
          <img src={ACTION_ICONS.cards} alt="cards" className="btn-icon" /> 卡牌
        </button>
        <button className="action-btn secondary" onClick={onShowTools}>
          <img src={ACTION_ICONS.tools} alt="tools" className="btn-icon" /> 道具
        </button>
        <button className="action-btn secondary" onClick={onShowStock}>
          <img src={ACTION_ICONS.stock} alt="stock" className="btn-icon" /> 股票
        </button>
        <button className="action-btn secondary" onClick={onShowAuction}>
          <img src={ACTION_ICONS.auction} alt="auction" className="btn-icon" /> 拍卖
        </button>
        {/* G31: 资产面板 */}
        <button className="action-btn secondary" onClick={onShowAssets}>
          <img src={ACTION_ICONS.assets} alt="assets" className="btn-icon" /> 资产
        </button>
        <button className="action-btn secondary" onClick={onShowSave}>
          存档
        </button>
        <button className="action-btn secondary" onClick={onShowLoad}>
          读档
        </button>
        {/* G30: 帮助 */}
        <button className="action-btn secondary" onClick={onShowHelp}>
          <img src={ACTION_ICONS.help} alt="help" className="btn-icon" /> 规则
        </button>
        {/* G34: 投降 */}
        <button className="action-btn" style={{ background: "#c0392b", color: "white" }} onClick={onSurrender}>
          <img src={ACTION_ICONS.surrender} alt="surrender" className="btn-icon" /> 投降
        </button>
      </div>
    </div>
  );
}
