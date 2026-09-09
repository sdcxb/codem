/**
 * 角色外观生成器 —— 为每个团队角色 / 子智能体「生成」一个不同的动画角色。
 *
 * 设计要点：
 * 1. **确定性**：外观完全由角色 id（无则用名称）哈希决定 —— 同一个角色
 *    无论何时打开图书馆，长相、配色、发型都一致（可被用户识别为「同一个人」）。
 * 2. **角色感知**：岗位职责会反向影响外观倾向（如「审查」类角色更容易戴眼镜、
 *    拿夹板；「编码」类更容易带终端道具），让外观与工作内容呼应。
 * 3. **皮肤契约**：所有颜色都是**语义令牌名**（`--accent` / `--success` …）或
 *    由令牌 `color-mix` 派生的 CSS 表达式，本文件不含任何硬编码色值。
 *
 * 外观由 12 套调色板 × 4 种身形 × 5 种发型 × 6 种头饰 × 6 种道具 × 4 种表情
 * 组合而成（理论 34560 种），足以让一个团队里每个角色都明显不同。
 */

import type { CharacterLook } from "../types";

export interface CharacterPalette {
  id: number;
  zh: string;
  en: string;
  /** 制服主色（身体） */
  uniform: string;
  /** 制服辅色（围裙 / 背心 / 领口） */
  trim: string;
  /** 发色 */
  hair: string;
  /** 皮肤色（由令牌派生，保持皮肤自适应） */
  skin: string;
  /** 裤 / 裙色 */
  legs: string;
}

/** 由令牌派生的皮肤色 —— 暖色低饱和，亮暗皮肤都成立 */
const SKIN_EXPR = "color-mix(in srgb, var(--warning) 26%, var(--bg-primary))";
/** 由令牌派生的裤装色 —— 深一档的通用色 */
const LEGS_EXPR = "color-mix(in srgb, var(--text-primary) 55%, var(--bg-primary))";

/** 12 套调色板（全部引用皮肤令牌，见 skin-tokens 契约） */
export const CHARACTER_PALETTES: CharacterPalette[] = [
  { id: 0, zh: "紫罗兰", en: "Violet", uniform: "var(--accent)", trim: "var(--accent-muted)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 1, zh: "靛青", en: "Indigo", uniform: "var(--security-ask)", trim: "var(--info)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 2, zh: "翡翠", en: "Emerald", uniform: "var(--success)", trim: "var(--success)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 3, zh: "琥珀", en: "Amber", uniform: "var(--warning)", trim: "var(--warning)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 4, zh: "朱砂", en: "Vermilion", uniform: "var(--error)", trim: "var(--error)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 5, zh: "湖蓝", en: "Azure", uniform: "var(--info)", trim: "var(--info)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 6, zh: "墨玉", en: "Obsidian", uniform: "var(--security-full)", trim: "var(--accent)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 7, zh: "青碧", en: "Teal", uniform: "var(--security-auto)", trim: "var(--success)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 8, zh: "雾灰", en: "Mist", uniform: "var(--text-secondary)", trim: "var(--text-muted)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 9, zh: "藕荷", en: "Lilac", uniform: "var(--accent-muted)", trim: "var(--accent)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 10, zh: "青瓷", en: "Celadon", uniform: "var(--border-primary)", trim: "var(--info)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
  { id: 11, zh: "橄榄", en: "Olive", uniform: "var(--border-secondary)", trim: "var(--warning)", hair: "var(--text-primary)", skin: SKIN_EXPR, legs: LEGS_EXPR },
];

/** 32 位字符串哈希（FNV-1a 变体，稳定跨平台） */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 从哈希里依次取指定位段（保证各维度互不相关且非负） */
function pick(hash: number, shift: number, mod: number): number {
  const mixed = ((hash >>> shift) ^ Math.imul(hash, shift + 3)) >>> 0;
  return mixed % mod;
}

/**
 * 生成角色外观。
 * @param seed 稳定 id（角色 id / 子智能体 id）；空则退化为 name
 * @param roleLabel 岗位/角色标签（影响外观倾向）
 */
export function generateLook(seed: string, roleLabel = ""): CharacterLook {
  const key = (seed || roleLabel || "anonymous").trim();
  const hash = hashString(key);
  const roleHash = hashString(roleLabel.toLowerCase());

  const paletteId = pick(hash, 0, CHARACTER_PALETTES.length);
  const body = pick(hash, 3, 4);
  const hair = pick(hash, 7, 5);
  const face = pick(hash, 11, 4);
  const scale = 0.88 + (pick(hash, 15, 25) / 100) * 1.0; // 0.88..1.13
  const hueShift = pick(hash, 19, 49) - 24; // -24..24

  return {
    paletteId,
    body,
    hair,
    hat: pickHat(roleHash, hash, roleLabel),
    prop: pickProp(roleHash, hash, roleLabel),
    face,
    scale: Math.round(scale * 100) / 100,
    hueShift,
  };
}

/** 头饰：岗位倾向 + 随机兜底（0 = 无头饰） */
function pickHat(roleHash: number, idHash: number, roleLabel: string): number {
  const role = roleLabel.toLowerCase();
  // 岗位倾向（命中直接给对应头饰，保证「一眼认出岗位」）
  if (/(队长|captain|leader|调度|chief|lead)/.test(role)) return 1; // 礼帽
  if (/(运维|ops|infra|deploy|机房|后台)/.test(role)) return 4; // 工帽
  if (/(研究|分析|research|explor|审查|评审|review)/.test(role)) return 2; // 学者帽
  if (/(写作|文档|doc|write|文案)/.test(role)) return 5; // 贝雷帽
  if (/(代码|编码|code|dev|实现|engineer)/.test(role)) return 3; // 耳机
  if (/(交付|汇总|deliver|输出)/.test(role)) return 1;
  return pick(roleHash ^ idHash, 5, 6);
}

/** 手持道具：岗位倾向 + 随机兜底（0 = 无道具） */
function pickProp(roleHash: number, idHash: number, roleLabel: string): number {
  const role = roleLabel.toLowerCase();
  if (/(代码|编码|code|dev|实现|engineer|运维|ops|terminal|bash)/.test(role)) return 1; // 终端
  if (/(研究|分析|research|explor|read|阅读)/.test(role)) return 2; // 书
  if (/(写作|文档|doc|write|文案|ppt)/.test(role)) return 3; // 笔
  if (/(审查|评审|review|测试|test|qa)/.test(role)) return 4; // 夹板
  if (/(交付|汇总|deliver|输出|搜索|检索|search)/.test(role)) return 5; // 包裹/放大镜
  return pick(roleHash ^ idHash, 9, 6);
}

/** 取调色板（越界安全） */
export function paletteOf(look: CharacterLook): CharacterPalette {
  const idx = ((look.paletteId % CHARACTER_PALETTES.length) + CHARACTER_PALETTES.length) % CHARACTER_PALETTES.length;
  return CHARACTER_PALETTES[idx];
}

/**
 * 生成角色的 CSS 变量表（内联 style 用）。
 * 值全部是令牌引用 / color-mix 表达式 —— 不含硬编码色值。
 */
export function characterStyleVars(look: CharacterLook): Record<string, string> {
  const p = paletteOf(look);
  return {
    "--lo-uniform": p.uniform,
    "--lo-trim": p.trim,
    "--lo-hair": p.hair,
    "--lo-skin": p.skin,
    "--lo-legs": p.legs,
    "--lo-uniform-dark": `color-mix(in srgb, ${p.uniform} 62%, var(--bg-primary))`,
    "--lo-uniform-light": `color-mix(in srgb, ${p.uniform} 45%, var(--text-primary))`,
    "--lo-outline": `color-mix(in srgb, var(--text-primary) 72%, transparent)`,
    "--lo-scale": String(look.scale),
    "--lo-hue": `${look.hueShift}deg`,
  };
}
