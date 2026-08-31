/**
 * GameLog — 游戏日志
 * G33: 支持日志颜色
 * G23: 显示胜利条件倍率
 * G8: 显示物价指数
 */

interface Props {
  log: string[];
  logColors?: string[];
  round: number;
  totalRounds: number;
  winningMultiplier?: number;
  priceIndex?: number;
}

export function GameLog({ log, logColors, round, totalRounds, winningMultiplier, priceIndex }: Props) {
  const reversed = [...log].reverse().slice(0, 50);
  const reversedColors = logColors ? [...logColors].reverse().slice(0, 50) : [];

  // 颜色映射
  const getColor = (color: string) => {
    const map: { [key: string]: string } = {
      "green": "#27ae60",
      "red": "#e74c3c",
      "blue": "#3498db",
      "gold": "#f1c40f",
      "yellow": "#f1c40f",
    };
    return map[color] || "#95a5a6";
  };

  return (
    <div className="game-log">
      <h3 className="panel-title">
        日志 <span className="round-info">{round}/{totalRounds}</span>
      </h3>
      {/* G8: 物价指数 */}
      {priceIndex !== undefined && (
        <div style={{ fontSize: 'var(--fs-sm)', color: "#bdc3c7", marginBottom: 4, padding: "2px 4px", background: "rgba(44, 62, 80, 0.4)", borderRadius: 4 }}>
          物价指数: <span style={{ color: "#f1c40f", fontWeight: "bold" }}>{priceIndex}</span>
        </div>
      )}
      {/* G23: 胜利条件 */}
      {winningMultiplier !== undefined && winningMultiplier > 0 && (
        <div style={{ fontSize: 'var(--fs-sm)', color: "#bdc3c7", marginBottom: 4, padding: "2px 4px", background: "rgba(241, 196, 15, 0.1)", borderRadius: 4 }}>
          胜利条件: <span style={{ color: "#f1c40f", fontWeight: "bold" }}>{winningMultiplier}x</span> 初始资金
        </div>
      )}
      <div className="log-list">
        {reversed.map((entry, idx) => (
          <div
            key={idx}
            className={`log-entry ${idx === 0 ? "latest" : ""}`}
            style={reversedColors[idx] ? { color: getColor(reversedColors[idx]) } : undefined}
          >
            {entry}
          </div>
        ))}
      </div>
    </div>
  );
}
