/**
 * Stack 清单校验（P2-7 的**本地包描述**，不接市场）。
 *
 * 背景：mcode-stack 的 stack 是「一个 plugin.json + 若干技能 + 一份 WORKFLOW.md + 版本号」。
 * 我们不需要它的市场/分发层，但需要它的一条纪律：**一个包引用的技能必须真实存在、
 * 版本必须可判定、工作流文件必须在包内** —— 否则"装了但跑不起来"。
 *
 * 本校验器只做本地结构校验：
 *   stacks/<name>/codem-stack.json
 *   { name, version (semver), description?, skills: string[], workflow?: string }
 * 不涉及：远程市场、版本递增门禁、安装/卸载（这些是产品决策，见 docs/project-guide/16 §5）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 校验一份清单（纯函数，便于判据）。
 * @returns 错误列表（空 = 通过）
 */
export function validateStackManifest(manifest, opts) {
  const errors = [];
  const where = opts.where ?? "codem-stack.json";
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [`${where}: 清单必须是 JSON 对象`];
  }
  if (typeof manifest.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    errors.push(`${where}: name 必须是小写字母/数字/连字符（实际 ${JSON.stringify(manifest.name)}）`);
  }
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    errors.push(`${where}: version 必须是 semver（实际 ${JSON.stringify(manifest.version)}）`);
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    errors.push(`${where}: description 必须是字符串`);
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    errors.push(`${where}: skills 必须是非空数组`);
  } else {
    const seen = new Set();
    for (const s of manifest.skills) {
      if (typeof s !== "string" || !s.trim()) {
        errors.push(`${where}: skills 里必须是非空字符串（实际 ${JSON.stringify(s)}）`);
        continue;
      }
      if (seen.has(s)) errors.push(`${where}: skills 重复：${s}`);
      seen.add(s);
      if (opts.skillNames && !opts.skillNames.has(s)) {
        errors.push(`${where}: 技能不存在：${s}（在 src/core/skills/ 下没有同名 SKILL.md）`);
      }
    }
  }
  if (manifest.workflow !== undefined) {
    if (typeof manifest.workflow !== "string" || !manifest.workflow.trim()) {
      errors.push(`${where}: workflow 必须是非空字符串`);
    } else if (path.isAbsolute(manifest.workflow) || manifest.workflow.split(/[\\/]/).includes("..")) {
      errors.push(`${where}: workflow 必须是包内相对路径（实际 ${manifest.workflow}）`);
    }
  }
  return errors;
}

/** 列出 src/core/skills 下可用的技能名 */
export function listAvailableSkills(repoRoot) {
  const dir = path.join(repoRoot, "src", "core", "skills");
  if (!fs.existsSync(dir)) return new Set();
  const names = new Set();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) names.add(entry.name);
  }
  return names;
}

/**
 * 扫描 stacks/<name>/codem-stack.json 并校验。
 * @returns { stacks: number, errors: string[] }
 */
export function scanStacks(repoRoot) {
  const root = path.join(repoRoot, "stacks");
  if (!fs.existsSync(root)) return { stacks: 0, errors: [] };
  const skillNames = listAvailableSkills(repoRoot);
  const errors = [];
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "codem-stack.json");
    if (!fs.existsSync(manifestPath)) continue;
    count += 1;
    const rel = path.relative(repoRoot, manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      errors.push(`${rel}: JSON 解析失败（${e.message}）`);
      continue;
    }
    errors.push(...validateStackManifest(manifest, { where: rel, skillNames }));
    if (manifest?.workflow) {
      const wf = path.join(root, entry.name, manifest.workflow);
      if (!fs.existsSync(wf)) errors.push(`${rel}: 声明的 workflow 不存在：${manifest.workflow}`);
    }
  }
  return { stacks: count, errors };
}

const isCli = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isCli) {
  const repoRoot = path.resolve(process.argv[2] ?? ".");
  const { stacks, errors } = scanStacks(repoRoot);
  if (errors.length) {
    console.error(`❌ stack 清单校验失败（${errors.length} 条）：`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(`✅ stack 清单校验通过（${stacks} 个包）`);
}
