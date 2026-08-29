/**
 * PlayerCards — 玩家信息卡片
 * 使用 Kenney CC0 PNG 图标，零 emoji
 */

import type { PlayerState } from "../types";
import { CharacterAvatar } from "./CharacterAvatar";
import charactersData from "../data/characters.json";

const ICON_BASE = new URL("../assets/sprites/icons/", import.meta.url).href;
const AI_ICON = ICON_BASE + "gear.png";
const HUMAN_ICON = ICON_BASE + "star.png";
const CHARACTERS = charactersData as { id: number; color: string; name: string }[];

interface Props {
  players: PlayerState[];
  currentPlayerIdx: number;
}

export function PlayerCards({ players, currentPlayerIdx }: Props) {
  return (
    <div className="player-cards">
      <h3 className="panel-title">玩家</h3>
      {players.map((p, idx) => {
        const isCurrent = idx === currentPlayerIdx;
        const wealth = p.cash + p.moneyInBank - p.loan;
        return (
          <div
            key={p.id}
            className={`player-card ${isCurrent ? "current" : ""} ${p.status === "bankrupted" ? "bankrupt" : ""}`}
            style={{ borderColor: p.color }}
          >
            <div className="player-card-header">
              <span className="player-name" style={{ color: p.color }}>
                <div className="player-avatar-mini">
                  <CharacterAvatar
                    characterId={p.characterId}
                    color={CHARACTERS[p.characterId]?.color || p.color}
                    size={20}
                  />
                </div>
                <img
                  src={p.isAI ? AI_ICON : HUMAN_ICON}
                  alt={p.isAI ? "AI" : "人类"}
                  className="player-type-icon"
                />
                {p.name}
              </span>
              {isCurrent && <span className="turn-indicator">▶</span>}
            </div>
            <div className="player-stats">
              <div className="stat-row">
                <span className="stat-label">现金</span>
                <span className="stat-value">{p.cash.toLocaleString()}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">存款</span>
                <span className="stat-value">{p.moneyInBank.toLocaleString()}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">贷款</span>
                <span className="stat-value">{p.loan > 0 ? `-${p.loan.toLocaleString()}` : "0"}</span>
              </div>
              <div className="stat-row total">
                <span className="stat-label">总资产</span>
                <span className="stat-value">{wealth.toLocaleString()}</span>
              </div>
            </div>
            <div className="player-extras">
              <div className="extra-row">
                <span>地产: {p.properties.length}</span>
                <span>卡牌: {p.cards.length}</span>
                <span>道具: {p.tools.reduce((s, t) => s + t.amount, 0)}</span>
              </div>
              <div className="extra-row">
                <span>点券: {p.points}</span>
                <span>交通: {["步行", "机车", "汽车"][p.trafficMethod]}</span>
              </div>
              {(p.daysInPrison > 0 || p.daysInHospital > 0 || p.daysInHotel > 0 || p.daysSleeping > 0 || p.daysSleepWalking > 0) && (
                <div className="status-effects">
                  {p.daysInPrison > 0 && <span className="badge prison">监狱{p.daysInPrison}天</span>}
                  {p.daysInHospital > 0 && <span className="badge hospital">医院{p.daysInHospital}天</span>}
                  {p.daysInHotel > 0 && <span className="badge hotel">酒店{p.daysInHotel}天</span>}
                  {p.daysSleeping > 0 && <span className="badge sleep">沉睡{p.daysSleeping}天</span>}
                  {p.daysSleepWalking > 0 && <span className="badge walk">梦游{p.daysSleepWalking}天</span>}
                  {p.daysStopping > 0 && <span className="badge stop">停留{p.daysStopping}天</span>}
                  {p.daysTortoiseWalking > 0 && <span className="badge turtle">乌龟{p.daysTortoiseWalking}天</span>}
                  {p.alliedDays > 0 && <span className="badge ally">同盟{p.alliedDays}天</span>}
                  {p.daysAssurance > 0 && <span className="badge assurance">保险{p.daysAssurance}天</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
