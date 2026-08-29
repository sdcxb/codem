/**
 * DicePanel — 骰子面板
 * 使用 Kenney CC0 PNG 骰子图标，零 emoji
 */

import type { GamePhase } from "../types";

const DICE_ICON_BASE = new URL("../assets/sprites/dice/", import.meta.url).href;

interface Props {
  phase: GamePhase;
  diceValues: number[];
  onRoll: () => void;
}

export function DicePanel({ phase, diceValues, onRoll }: Props) {
  return (
    <div className="dice-panel">
      <div className="dice-display">
        {diceValues.length > 0 ? (
          diceValues.map((v, i) => (
            <img
              key={i}
              src={`${DICE_ICON_BASE}dice_${v}.png`}
              alt={`骰子${v}`}
              className="dice-face-img"
            />
          ))
        ) : (
          <div className="dice-placeholder">准备掷骰</div>
        )}
      </div>
      {diceValues.length > 0 && (
        <div className="dice-sum">
          合计: {diceValues.reduce((a, b) => a + b, 0)}
        </div>
      )}
    </div>
  );
}
