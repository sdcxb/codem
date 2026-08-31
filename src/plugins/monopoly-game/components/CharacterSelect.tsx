/**
 * CharacterSelect — 角色选择组件 (G3/G14)
 * 玩家选择角色，不同角色有差异化属性
 * G14: 使用 SVG 立绘替代文字头像
 */

import { useState } from "react";
import type { CharacterDef } from "../types";
import { CharacterAvatar } from "./CharacterAvatar";
import charactersData from "../data/characters.json";

interface Props {
  onSelect: (characterId: number) => void;
  onBack: () => void;
}

export function CharacterSelect({ onSelect, onBack }: Props) {
  const [selectedId, setSelectedId] = useState<number>(0);
  const characters = charactersData as CharacterDef[];

  return (
    <div className="monopoly-game-wrapper">
      <div className="game-start-screen">
        <h1>选择角色</h1>
        <p style={{ color: "#bdc3c7", fontSize: "var(--fs-md)", marginBottom: "12px" }}>
          每个角色拥有独特能力，影响游戏策略
        </p>
        <div className="character-grid">
          {characters.map((char) => (
            <div
              key={char.id}
              className={`character-card ${selectedId === char.id ? "selected" : ""}`}
              style={{ borderColor: char.color }}
              onClick={() => setSelectedId(char.id)}
            >
              <div className="character-portrait" style={{ background: `linear-gradient(135deg, ${char.color}33, ${char.color}11)` }}>
                <CharacterAvatar characterId={char.id} color={char.color} size={64} />
              </div>
              <div className="character-name" style={{ color: char.color }}>{char.name}</div>
              <div className="character-special">{char.specialDesc}</div>
              <div className="character-cash">初始资金: {Math.floor(15000 * char.initCashRatio).toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div className="character-actions">
          <button className="action-btn skip" onClick={onBack}>返回</button>
          <button className="game-start-btn" onClick={() => onSelect(selectedId)}>
            确认选择
          </button>
        </div>
      </div>
    </div>
  );
}
