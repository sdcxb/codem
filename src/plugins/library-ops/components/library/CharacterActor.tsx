/**
 * CharacterActor —— 图书馆内的一个动画角色（SVG + CSS 关键帧）。
 *
 * 每个团队角色 / 子智能体由 `generateLook()` 生成不同外观（12 套调色板 ×
 * 4 种身形 × 5 种发型 × 6 种头饰 × 6 种道具 × 4 种表情），并在图书馆的
 * 岗位上按当前工作状态播放不同动画。
 *
 * 颜色全部来自 `characterStyleVars()` 生成的 CSS 变量（值为语义令牌或
 * color-mix 表达式），因此四套皮肤（default 亮/暗、dream、hub）自动适配，
 * 满足插件皮肤兼容契约（禁止硬编码色值）。
 */

import { memo } from "react";
import type { ActorActivity, CharacterLook } from "../../types";
import { characterStyleVars } from "../../data/characters";

export interface CharacterActorProps {
  look: CharacterLook;
  anim: ActorActivity;
  /** 动画相位偏移（0..1，避免所有角色同频摆动） */
  phase?: number;
  /** 是否正在行走（驱动腿部摆动类） */
  walking?: boolean;
  className?: string;
}

const VIEW_W = 26;
const VIEW_H = 34;

function Hair({ variant }: { variant: number }) {
  switch (variant) {
    case 0:
      return <path className="lo-hair" d="M7.2 10.4c0-3 2.6-5 5.8-5s5.8 2 5.8 5c0-1.6-2.2-2.4-5.8-2.4S7.2 8.8 7.2 10.4Z" />;
    case 1:
      return <path className="lo-hair" d="M6.6 15c-.8-6 2-10.4 6.4-10.4S20 8.6 19.4 15c-.5-3-1-4.6-1.6-5.2-2.6.9-6.4.9-9.6-.3-.8.9-1.2 2.6-1.6 5.5Z" />;
    case 2:
      return (
        <>
          <path className="lo-hair" d="M7 10.2C7 7 9.6 5 13 5s6 2 6 5.2c0-1.5-2.4-2.3-6-2.3S7 8.7 7 10.2Z" />
          <circle className="lo-hair" cx="13" cy="5.1" r="2.1" />
        </>
      );
    case 3:
      return (
        <g className="lo-hair">
          <circle cx="9.4" cy="8.6" r="2" />
          <circle cx="13" cy="7.6" r="2.1" />
          <circle cx="16.6" cy="8.6" r="2" />
          <circle cx="11.2" cy="6.6" r="1.6" />
          <circle cx="14.8" cy="6.6" r="1.6" />
        </g>
      );
    default:
      return null;
  }
}

function Hat({ variant }: { variant: number }) {
  switch (variant) {
    case 1: // 礼帽（队长）
      return (
        <g className="lo-hat">
          <rect x="8" y="1.4" width="10" height="4.6" rx="1" />
          <rect x="5.6" y="5.6" width="14.8" height="1.6" rx="0.8" />
          <rect x="8" y="4.6" width="10" height="1.1" className="lo-trim-band" />
        </g>
      );
    case 2: // 学者帽（研究 / 评审）
      return (
        <g className="lo-hat">
          <path d="M4.6 5.2 13 2.2l8.4 3-8.4 3z" />
          <rect x="8.6" y="6.6" width="8.8" height="2.6" rx="0.7" />
          <rect x="12.4" y="7.2" width="1.2" height="3.4" />
        </g>
      );
    case 3: // 耳机（编码）
      return (
        <g className="lo-hat">
          {/* 耳机横梁用独立类：避免被 `.lo-hat path { fill }` 覆盖成实心 */}
          <path className="lo-headphone-band" d="M6.4 10.6a6.6 6.6 0 0 1 13.2 0" />
          <rect x="4.9" y="10.2" width="2.6" height="4.2" rx="1.2" />
          <rect x="18.5" y="10.2" width="2.6" height="4.2" rx="1.2" />
        </g>
      );
    case 4: // 工帽（运维）
      return (
        <g className="lo-hat">
          <path d="M7 7.6c0-3 2.6-5 6-5s6 2 6 5z" />
          <rect x="5.4" y="7.4" width="15.2" height="1.8" rx="0.9" />
        </g>
      );
    case 5: // 贝雷帽（写作）
      return (
        <g className="lo-hat">
          <ellipse cx="13" cy="6" rx="7.2" ry="3.4" />
          <circle cx="18.4" cy="4.2" r="1.1" className="lo-trim-band" />
        </g>
      );
    default:
      return null;
  }
}

/**
 * 手持道具。
 * 注意：整个角色 SVG 会按朝向做 `scaleX(±1)` 镜像，因此道具**必须固定在同一只手**
 * （镜像后自然出现在另一侧屏幕上）。早期按 facing 交换 x 会被二次镜像，导致转向时道具换手。
 */
function Prop({ variant }: { variant: number }) {
  const x = 20.2;
  switch (variant) {
    case 1: // 终端 / 笔电
      return (
        <g className="lo-prop" transform={`translate(${x}, 17.4)`}>
          <rect x="-3.4" y="-3.2" width="6.8" height="4.6" rx="0.7" />
          <rect x="-4.2" y="1.6" width="8.4" height="1.2" rx="0.6" className="lo-trim-band" />
        </g>
      );
    case 2: // 书
      return (
        <g className="lo-prop" transform={`translate(${x}, 18.2)`}>
          <path d="M-3.4-2.6h6.8v5.2h-6.8z" />
          <path d="M0-2.6v5.2" className="lo-trim-band" strokeWidth="0.6" />
        </g>
      );
    case 3: // 笔
      return (
        <g className="lo-prop" transform={`translate(${x}, 18.6)`}>
          <rect x="-1" y="-4.4" width="2" height="8.8" rx="0.9" />
          <path d="M-1 4.4h2l-1 1.8z" className="lo-trim-band" />
        </g>
      );
    case 4: // 夹板（审查）
      return (
        <g className="lo-prop" transform={`translate(${x}, 18.4)`}>
          <rect x="-3" y="-3.6" width="6" height="7.6" rx="0.8" />
          <rect x="-1.6" y="-4.6" width="3.2" height="1.4" rx="0.6" className="lo-trim-band" />
          <rect x="-2" y="-1.6" width="4" height="0.6" className="lo-trim-band" />
          <rect x="-2" y="0.2" width="4" height="0.6" className="lo-trim-band" />
        </g>
      );
    case 5: // 放大镜 / 包裹（检索 · 交付）
      return (
        <g className="lo-prop" transform={`translate(${x}, 17.8)`}>
          <circle cx="0" cy="0" r="2.6" fill="none" strokeWidth="1.2" />
          <rect x="1.6" y="2.2" width="1.2" height="3.4" rx="0.6" transform="rotate(-45 2.2 3.9)" />
        </g>
      );
    default:
      return null;
  }
}

function Face({ variant }: { variant: number }) {
  switch (variant) {
    case 1: // 微笑
      return (
        <g className="lo-face">
          <circle cx="11" cy="12.2" r="0.7" />
          <circle cx="15" cy="12.2" r="0.7" />
          <path d="M11.2 14.2c.8 1 2.8 1 3.6 0" fill="none" strokeWidth="0.7" strokeLinecap="round" />
        </g>
      );
    case 2: // 专注（眼镜）
      return (
        <g className="lo-face">
          <circle cx="11" cy="12.2" r="1.5" fill="none" strokeWidth="0.6" />
          <circle cx="15" cy="12.2" r="1.5" fill="none" strokeWidth="0.6" />
          <path d="M12.5 12.2h1" strokeWidth="0.6" />
          <circle cx="11" cy="12.2" r="0.6" />
          <circle cx="15" cy="12.2" r="0.6" />
        </g>
      );
    case 3: // 惊讶
      return (
        <g className="lo-face">
          <circle cx="11" cy="12" r="0.8" />
          <circle cx="15" cy="12" r="0.8" />
          <circle cx="13" cy="14.3" r="0.9" fill="none" strokeWidth="0.6" />
        </g>
      );
    default: // 中性
      return (
        <g className="lo-face">
          <circle cx="11" cy="12.2" r="0.7" />
          <circle cx="15" cy="12.2" r="0.7" />
          <path d="M11.8 14.4h2.4" strokeWidth="0.6" strokeLinecap="round" />
        </g>
      );
  }
}

function Body({ variant }: { variant: number }) {
  switch (variant) {
    case 1: // 宽身 + 围裙
      return (
        <>
          <path className="lo-body" d="M7.4 16.4h11.2v8.4H7.4z" />
          <path className="lo-apron" d="M9.6 18.4h6.8v6.4H9.6z" />
        </>
      );
    case 2: // 修身 + 领口
      return (
        <>
          <path className="lo-body" d="M8.4 16.4h9.2v8.4H8.4z" />
          <path className="lo-apron" d="M11 16.4h4l-2 2.6z" />
        </>
      );
    case 3: // 背带工装
      return (
        <>
          <path className="lo-body" d="M7.8 16.4h10.4v8.4H7.8z" />
          <path className="lo-apron" d="M9.2 16.4h1.6v8.4H9.2zm6 0h1.6v8.4h-1.6z" />
        </>
      );
    default: // 直筒
      return <path className="lo-body" d="M8 16.4h10v8.4H8z" />;
  }
}

export const CharacterActor = memo(function CharacterActor({
  look,
  anim,
  phase = 0,
  walking = false,
  className = "",
}: CharacterActorProps) {
  const style = characterStyleVars(look) as React.CSSProperties;

  return (
    <svg
      className={`lo-actor ${className}`}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={VIEW_W * 2}
      height={VIEW_H * 2}
      data-anim={anim}
      data-walking={walking ? "1" : "0"}
      style={style}
      role="img"
      aria-hidden="true"
    >
      <ellipse className="lo-shadow" cx={13} cy={32.4} rx={6.6} ry={2.1} />
      <g className="lo-actor__body" style={{ animationDelay: `${-phase * 2}s` }}>
        {/* 腿 */}
        <g className="lo-actor__legs">
          <rect className="lo-leg" x="10" y="24.6" width="2.4" height="7" rx="1.1" />
          <rect className="lo-leg" x="13.6" y="24.6" width="2.4" height="7" rx="1.1" />
        </g>
        {/* 手臂 */}
        <rect className="lo-arm lo-arm--l" x="5.9" y="17" width="2.3" height="7.4" rx="1.1" />
        <rect className="lo-arm lo-arm--r" x="17.8" y="17" width="2.3" height="7.4" rx="1.1" />
        {/* 躯干 */}
        <Body variant={look.body} />
        {/* 头 */}
        <g className="lo-actor__head">
          <circle className="lo-head" cx={13} cy={11.6} r={4.9} />
          <Hair variant={look.hair} />
          <Hat variant={look.hat} />
          <Face variant={look.face} />
        </g>
        {/* 手持道具 */}
        <Prop variant={look.prop} />
      </g>
    </svg>
  );
});
