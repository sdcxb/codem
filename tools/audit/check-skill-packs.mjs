#!/usr/bin/env node
/**
 * 技能包校验（P2-7）—— 仓库自带的 `SKILL.md` 也要过门禁。
 *
 * ## 为什么需要它
 *
 * 技能不是"文档"，它是**每一轮都会进请求的上下文**（`buildSkillPrompt` 把 name +
 * description 注入系统提示）和**一份会被 load_skill 全量读进来的指令**。所以它同时受
 * 两套约束：
 *
 * - **结构**：没有 frontmatter / `name` 与目录不一致 / `description` 为空 ⇒ 这个技能
 *   永远不会被正确触发，而且装到别处也会坏（这是 mcode-stack `check.mjs` 的主要职责）；
 * - **预算**：`description` 超过 1024 字 ⇒ 每轮都在为一段"只用来触发"的文字付钱。
 *   运行时已经会截断（`clampSkillDescription`），这里是在**提交前**把它拦下来。
 *
 * ## 与运行时校验的分工
 *
 * | 场景 | 谁负责 |
 * | --- | --- |
 * | 用户装的技能（可能很啰嗦/不规整） | 运行时：截断 + 日志，不拒绝（不该让人装不进技能） |
 * | **仓库自带的技能**（`src/core/skills/*`） | 这里：直接报错，提交前修 |
 * | 注册表里的内置技能（`skill.ts::registerBuiltinSkills`） | `src/test/context-tax-budget.test.ts` 的同一条预算 |
 *
 * ## 用法
 *
 * ```powershell
 * node tools/audit/check-skill-packs.mjs            # 校验仓库技能目录
 * node tools/audit/check-skill-packs.mjs --json     # 机器可读
 * ```
 *
 * 退出码：0 = 通过；1 = 有错误。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DIR = path.join(ROOT, "src", "core", "skills");

/** 与运行时同一条预算（`skill.ts` 的 SKILL_DESCRIPTION_PROMPT_LIMIT） */
export const DESCRIPTION_LIMIT = 1024;
/** 软预算：超过它只警告 —— 描述应当"够触发"，不是使用手册 */
export const DESCRIPTION_SOFT_LIMIT = 400;
/** 技能 id：小写字母开头，字母/数字/连字符 */
const ID_RE = /^[a-z][a-z0-9-]*$/u;

function hasBom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

/** 读出 frontmatter 块（含边界）；没有闭合块时返回 null */
function frontmatterBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  return m ? m[1] : null;
}

/** 取单行 `key: value`（支持引号；与仓库现有 SKILL.md 的写法一致） */
function field(block, key) {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, "mu");
  const m = re.exec(block);
  if (!m) return null;
  let value = m[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

/**
 * 校验一个技能根目录下的所有技能。
 * @param {string} dir
 * @returns {{ errors: string[], warnings: string[], skills: Array<{ id: string, descriptionChars: number }> }}
 */
export function scanSkillPacks(dir = DEFAULT_DIR) {
  const errors = [];
  const warnings = [];
  const skills = [];

  if (!fs.existsSync(dir)) {
    return { errors: [`技能目录不存在：${dir}`], warnings, skills };
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) errors.push(`${dir} 下没有任何技能目录`);

  for (const entry of entries) {
    const id = entry.name;
    const where = `src/core/skills/${id}/SKILL.md`;
    const file = path.join(dir, id, "SKILL.md");

    if (!fs.existsSync(file)) {
      errors.push(`${where}: 缺少 SKILL.md`);
      continue;
    }
    const buffer = fs.readFileSync(file);
    if (hasBom(buffer)) errors.push(`${where}: 带 BOM（no-bom.test.ts 会红）`);

    const text = buffer.toString("utf8");
    const block = frontmatterBlock(text);
    if (block === null) {
      errors.push(`${where}: 必须以闭合的 YAML frontmatter 块开头`);
      continue;
    }

    const name = field(block, "name");
    const description = field(block, "description") ?? "";

    if (!name) errors.push(`${where}: frontmatter 缺 name`);
    else if (name !== id) errors.push(`${where}: name「${name}」与目录名「${id}」不一致`);
    if (!ID_RE.test(id)) errors.push(`${where}: 技能 id「${id}」应为小写字母、数字与连字符`);

    if (!description) {
      errors.push(`${where}: frontmatter 缺 description（没有它技能永远不会被触发）`);
    } else if (description.length > DESCRIPTION_LIMIT) {
      errors.push(
        `${where}: description ${description.length} 字，超过预算 ${DESCRIPTION_LIMIT} 字 —— ` +
          `把细则移进正文（正文由 load_skill 按需加载）`,
      );
    } else if (description.length > DESCRIPTION_SOFT_LIMIT) {
      warnings.push(`${where}: description ${description.length} 字，偏长（软预算 ${DESCRIPTION_SOFT_LIMIT}）`);
    }

    skills.push({ id, descriptionChars: description.length });
  }

  return { errors, warnings, skills };
}

function main(argv) {
  const json = argv.includes("--json");
  const result = scanSkillPacks();

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const w of result.warnings) console.warn(`warn: ${w}`);
    for (const e of result.errors) console.error(`error: ${e}`);
    const total = result.skills.reduce((n, s) => n + s.descriptionChars, 0);
    console.log(
      `skill-packs: ${result.skills.length} 个技能，description 合计 ${total} 字符，` +
        `${result.errors.length} 个错误 / ${result.warnings.length} 个警告`,
    );
  }

  if (result.errors.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
