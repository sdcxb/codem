/**
 * CharacterAvatar — 角色立绘 SVG 组件 (G14)
 * 根据角色ID生成不同风格的 SVG 立绘
 */

interface Props {
  characterId: number;
  color: string;
  size?: number;
}

export function CharacterAvatar({ characterId, color, size = 48 }: Props) {
  const id = characterId;
  // 不同角色用不同的配饰和表情
  const accessories: Record<number, { hat?: string; eye?: string; mouth?: string }> = {
    0: { hat: "crown",   eye: "happy",  mouth: "smirk"  }, // 富豪：皇冠
    1: { hat: "star",    eye: "wink",   mouth: "grin"   }, // 幸运星：星星帽
    2: { hat: "hat",     eye: "open",   mouth: "smile"  }, // 探险家：探险帽
    3: { hat: "tie",     eye: "serious",mouth: "neutral"}, // 地产大亨：领带
    4: { hat: "glasses", eye: "sparkle",mouth: "smile"  }, // 股神：眼镜
    5: { hat: "headband",eye: "cool",   mouth: "smirk"  }, // 忍者：头巾
  };
  const acc = accessories[id] || accessories[0];
  const s = size;
  const cx = s / 2;
  const cy = s * 0.42;

  return (
    <svg width={s} height={s} viewBox="0 0 48 48" style={{ display: "block" }}>
      {/* 背景圆 */}
      <circle cx={cx} cy={cy} r={s * 0.35} fill={color} opacity={0.85} />
      {/* 脸 */}
      <circle cx={cx} cy={cy} r={s * 0.22} fill="#fdebd0" />
      {/* 头发 */}
      <path d={`M ${cx - s*0.22} ${cy - s*0.05} Q ${cx} ${cy - s*0.4} ${cx + s*0.22} ${cy - s*0.05} L ${cx + s*0.18} ${cy + s*0.02} Q ${cx} ${cy - s*0.25} ${cx - s*0.18} ${cy + s*0.02} Z`} fill="#3e2723" />

      {/* 配饰 */}
      {acc.hat === "crown" && (
        <path d={`M ${cx - s*0.25} ${cy - s*0.18} L ${cx - s*0.15} ${cy - s*0.35} L ${cx - s*0.07} ${cy - s*0.22} L ${cx} ${cy - s*0.4} L ${cx + s*0.07} ${cy - s*0.22} L ${cx + s*0.15} ${cy - s*0.35} L ${cx + s*0.25} ${cy - s*0.18} Z`} fill="#f1c40f" stroke="#e67e22" strokeWidth={0.5} />
      )}
      {acc.hat === "star" && (
        <path d={`M ${cx} ${cy - s*0.38} L ${cx + s*0.04} ${cy - s*0.28} L ${cx + s*0.14} ${cy - s*0.27} L ${cx + s*0.07} ${cy - s*0.21} L ${cx + s*0.09} ${cy - s*0.12} L ${cx} ${cy - s*0.17} L ${cx - s*0.09} ${cy - s*0.12} L ${cx - s*0.07} ${cy - s*0.21} L ${cx - s*0.14} ${cy - s*0.27} L ${cx - s*0.04} ${cy - s*0.28} Z`} fill="#f39c12" />
      )}
      {acc.hat === "hat" && (
        <path d={`M ${cx - s*0.28} ${cy - s*0.15} L ${cx + s*0.28} ${cy - s*0.15} L ${cx + s*0.22} ${cy - s*0.35} L ${cx - s*0.22} ${cy - s*0.35} Z`} fill="#5d4037" />
      )}
      {acc.hat === "tie" && (
        <path d={`M ${cx - s*0.04} ${cy - s*0.05} L ${cx + s*0.04} ${cy - s*0.05} L ${cx + s*0.06} ${cy + s*0.15} L ${cx} ${cy + s*0.22} L ${cx - s*0.06} ${cy + s*0.15} Z`} fill="#c0392b" />
      )}
      {acc.hat === "glasses" && (
        <g stroke="#2c3e50" strokeWidth={1} fill="none">
          <circle cx={cx - s*0.1} cy={cy} r={s*0.06} />
          <circle cx={cx + s*0.1} cy={cy} r={s*0.06} />
          <line x1={cx - s*0.04} y1={cy} x2={cx + s*0.04} y2={cy} />
        </g>
      )}
      {acc.hat === "headband" && (
        <rect x={cx - s*0.24} y={cy - s*0.12} width={s*0.48} height={s*0.06} fill="#e74c3c" rx={2} />
      )}

      {/* 眼睛 */}
      {acc.eye === "happy" && (
        <g stroke="#2c3e50" strokeWidth={1.2} fill="none">
          <path d={`M ${cx - s*0.12} ${cy} Q ${cx - s*0.08} ${cy - s*0.04} ${cx - s*0.04} ${cy}`} />
          <path d={`M ${cx + s*0.04} ${cy} Q ${cx + s*0.08} ${cy - s*0.04} ${cx + s*0.12} ${cy}`} />
        </g>
      )}
      {acc.eye === "wink" && (
        <g stroke="#2c3e50" strokeWidth={1.2}>
          <path d={`M ${cx - s*0.12} ${cy} Q ${cx - s*0.08} ${cy - s*0.04} ${cx - s*0.04} ${cy}`} fill="none" />
          <line x1={cx + s*0.04} y1={cy} x2={cx + s*0.12} y2={cy} />
        </g>
      )}
      {acc.eye === "open" && (
        <g fill="#2c3e50">
          <circle cx={cx - s*0.08} cy={cy} r={s*0.025} />
          <circle cx={cx + s*0.08} cy={cy} r={s*0.025} />
        </g>
      )}
      {acc.eye === "serious" && (
        <g stroke="#2c3e50" strokeWidth={1.5}>
          <line x1={cx - s*0.12} y1={cy} x2={cx - s*0.04} y2={cy} />
          <line x1={cx + s*0.04} y1={cy} x2={cx + s*0.12} y2={cy} />
        </g>
      )}
      {acc.eye === "sparkle" && (
        <g fill="#2c3e50">
          <circle cx={cx - s*0.08} cy={cy} r={s*0.03} />
          <circle cx={cx + s*0.08} cy={cy} r={s*0.03} />
          <circle cx={cx - s*0.06} cy={cy - s*0.02} r={s*0.01} fill="#fff" />
          <circle cx={cx + s*0.1} cy={cy - s*0.02} r={s*0.01} fill="#fff" />
        </g>
      )}
      {acc.eye === "cool" && (
        <g fill="#2c3e50">
          <rect x={cx - s*0.14} y={cy - s*0.02} width={s*0.08} height={s*0.03} rx={1} />
          <rect x={cx + s*0.06} y={cy - s*0.02} width={s*0.08} height={s*0.03} rx={1} />
        </g>
      )}

      {/* 嘴巴 */}
      {acc.mouth === "smirk" && (
        <path d={`M ${cx - s*0.03} ${cy + s*0.1} Q ${cx + s*0.05} ${cy + s*0.12} ${cx + s*0.08} ${cy + s*0.08}`} stroke="#2c3e50" strokeWidth={1} fill="none" />
      )}
      {acc.mouth === "grin" && (
        <path d={`M ${cx - s*0.08} ${cy + s*0.08} Q ${cx} ${cy + s*0.18} ${cx + s*0.08} ${cy + s*0.08} Z`} fill="#e74c3c" stroke="#2c3e50" strokeWidth={0.5} />
      )}
      {acc.mouth === "smile" && (
        <path d={`M ${cx - s*0.06} ${cy + s*0.08} Q ${cx} ${cy + s*0.14} ${cx + s*0.06} ${cy + s*0.08}`} stroke="#2c3e50" strokeWidth={1.2} fill="none" />
      )}
      {acc.mouth === "neutral" && (
        <line x1={cx - s*0.04} y1={cy + s*0.1} x2={cx + s*0.04} y2={cy + s*0.1} stroke="#2c3e50" strokeWidth={1.2} />
      )}
    </svg>
  );
}
