/**
 * PPT 风格技能注册器
 *
 * 直接集成 oh-my-ppt 项目的 SKILL.md 风格技能文件。
 * 通过 Cordis SkillRegistry 注册，AI 在生成 PPT 时通过 load_skill 按需加载，
 * 而非将全文注入 systemPrompt（避免 token 爆炸）。
 *
 * 来源: oh-my-ppt (https://github.com/arcsin1/oh-my-ppt)
 * 集成方式: 将 resources/styles/{styleId}/SKILL.md 作为 Cordis skill 注册
 *
 * 注册两类 skill:
 * 1. 风格技能 (76 种): ppt-style-{styleId} — 每种 PPT 风格的完整视觉指令
 * 2. 产品技能 (4 种): ppt-layout, ppt-chart, ppt-anim, ppt-source-reading — 布局/图表/动画/来源阅读规则
 */

import type { SkillDefinition } from '../skill/skill';
import { parseSkillMarkdown } from '../skill/skill';

// Vite 构建时收集所有 SKILL.md 文件 (eager + raw)
const styleSkillModules = import.meta.glob(
  './skills/styles/*/SKILL.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

const productSkillModules = import.meta.glob(
  './skills/products/*/SKILL.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

/** 解析所有风格 SKILL.md 为 SkillDefinition */
function parseStyleSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  for (const [path, content] of Object.entries(styleSkillModules)) {
    const match = path.match(/styles\/([^/]+)\/SKILL\.md$/);
    if (!match) continue;

    const styleId = match[1];
    const skill = parseSkillMarkdown(content, path);
    if (!skill) continue;

    // 重命名: ppt-style-{styleId}，避免与已有 skill 冲突
    skill.name = `ppt-style-${styleId}`;
    skill.description = skill.description || `PPT 风格: ${styleId}`;
    skill.source = 'builtin';
    skill.contextMode = 'inline';
    skill.tags = ['ppt', 'style', styleId];
    skill.whenToUse = `When generating PPT slides with the "${styleId}" style. Load this skill to get the complete visual style instructions.`;

    skills.push(skill);
  }

  return skills;
}

/** 解析所有产品技能 SKILL.md 为 SkillDefinition */
function parseProductSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  for (const [path, content] of Object.entries(productSkillModules)) {
    const match = path.match(/products\/([^/]+)\/SKILL\.md$/);
    if (!match) continue;

    const skillId = match[1];
    const skill = parseSkillMarkdown(content, path);
    if (!skill) continue;

    // 重命名: ppt-{skillId}，加 ppt 前缀避免冲突
    skill.name = `ppt-${skillId}`;
    skill.source = 'builtin';
    skill.contextMode = 'inline';
    skill.tags = ['ppt', skillId];

    skills.push(skill);
  }

  return skills;
}

/** 标记是否已注册 */
let registered = false;

/**
 * 注册 oh-my-ppt 的所有技能到 SkillRegistry
 *
 * 在 PPT 模块初始化时调用（幂等，重复调用安全）。
 * 注册后，AI 在 systemPrompt 中只能看到 skill 的 name + description，
 * 需要通过 load_skill 工具按需加载完整指令——这就是 Cordis 的 progressive disclosure。
 */
export function registerOhMyPptSkills(registry: {
  register: (skill: SkillDefinition) => void;
  get: (name: string) => SkillDefinition | undefined;
}): number {
  if (registered) return 0;
  registered = true;

  let count = 0;

  // 注册风格技能
  for (const skill of parseStyleSkills()) {
    // 跳过已存在的（用户可能已自定义同名 skill）
    if (!registry.get(skill.name)) {
      registry.register(skill);
      count++;
    }
  }

  // 注册产品技能
  for (const skill of parseProductSkills()) {
    if (!registry.get(skill.name)) {
      registry.register(skill);
      count++;
    }
  }

  console.log(`[ppt-skills] Registered ${count} oh-my-ppt skills (76 styles + 4 product skills)`);
  return count;
}
