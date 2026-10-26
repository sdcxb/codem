/**
 * 项目文档集（docs/project-guide）的新鲜度检查与基线同步。
 *
 * 设计目标：
 * - **发版时**能机器判断「版本号变了，文档没跟上」→ 直接红，而不是靠人记；
 * - 检查必须快（不跑测试、不读大文件、不依赖 Windows 专有命令）；
 * - 计数类信息（测试文件数 / core 子域数 / 表数 / 命令注解数）只做**警告**，
 *   因为开发期每天都会变；发版时用 --write 刷新即可。
 * - 版本一致性是**硬错误**：package.json / tauri.conf.json / Cargo.toml /
 *   BASELINE.json / 四份当前文档必须一致。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GUIDE_DIR = path.join(ROOT, "docs", "project-guide");
export const BASELINE_PATH = path.join(GUIDE_DIR, "BASELINE.json");

/** 必须存在的当前文档（README 是索引；00 是接手手册）。 */
export const REQUIRED_DOCS = [
  "README.md",
  "00-AGENT-HANDBOOK.md",
  "01-PRODUCT-OVERVIEW.md",
  "02-CODE-MAP.md",
  "03-RUNTIME-FLOWS.md",
  "04-FEATURE-MODULES.md",
  "05-UI-UX.md",
  "06-DATA-STORAGE.md",
  "07-BACKEND-IPC.md",
  "08-ENGINEERING-GATES.md",
  "09-CURRENT-STATE.md",
  "10-GAME-AND-PROTOTYPE.md",
  "11-HANDOFF-PROMPT.md",
  "12-DOC-MAINTENANCE.md",
];

/** 版本号必须出现的「当前」文档；历史文档不参与。 */
const VERSION_DOCS = ["README.md", "00-AGENT-HANDBOOK.md", "01-PRODUCT-OVERVIEW.md", "09-CURRENT-STATE.md"];

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function hasBom(file) {
  const b = fs.readFileSync(file);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

export function packageVersion() {
  return readJson(path.join(ROOT, "package.json")).version;
}

export function tauriVersion() {
  return readJson(path.join(ROOT, "src-tauri", "tauri.conf.json")).version;
}

export function cargoVersion() {
  const text = readText(path.join(ROOT, "src-tauri", "Cargo.toml"));
  const m = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Cargo.toml 里找不到 [package] version");
  return m[1];
}

function countTestFiles() {
  const dir = path.join(ROOT, "src", "test");
  return fs.readdirSync(dir).filter((n) => /\.test\.(ts|tsx)$/.test(n)).length;
}

function countCoreDirs() {
  return fs.readdirSync(path.join(ROOT, "src", "core"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).length;
}

function countSqliteTables() {
  const text = readText(path.join(ROOT, "src-tauri", "codem-db", "sql", "schema.sql"));
  return (text.match(/^CREATE TABLE/gim) || []).length;
}

function countTauriCommandAnnotations() {
  const base = path.join(ROOT, "src-tauri", "src");
  let n = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".rs")) {
        n += (readText(p).match(/#\[tauri::command\]/g) || []).length;
      }
    }
  };
  walk(base);
  return n;
}

/** 当前可静态统计的事实；testCases 不在内（要跑全量才知道）。 */
export function collectFacts() {
  return {
    version: packageVersion(),
    updatedAt: new Date().toISOString().slice(0, 10),
    testFiles: countTestFiles(),
    coreDirs: countCoreDirs(),
    sqliteTables: countSqliteTables(),
    tauriCommandAnnotations: countTauriCommandAnnotations(),
  };
}

export function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return readJson(BASELINE_PATH);
}

/**
 * 检查文档集是否跟得上当前版本。
 * @returns {{ ok: boolean, problems: string[], warnings: string[], facts: object, baseline: object|null }}
 */
export function checkProjectGuide() {
  const problems = [];
  const warnings = [];
  let facts;
  try {
    facts = collectFacts();
  } catch (e) {
    return { ok: false, problems: [`无法计算基线：${e.message}`], warnings, facts: null, baseline: null };
  }

  // 1) 四处版本一致
  let tv, cv;
  try {
    tv = tauriVersion();
  } catch (e) {
    problems.push(`读取 tauri.conf.json 版本失败：${e.message}`);
  }
  try {
    cv = cargoVersion();
  } catch (e) {
    problems.push(`读取 Cargo.toml 版本失败：${e.message}`);
  }
  if (tv && tv !== facts.version) problems.push(`tauri.conf.json 版本 ${tv} ≠ package.json ${facts.version}`);
  if (cv && cv !== facts.version) problems.push(`Cargo.toml 版本 ${cv} ≠ package.json ${facts.version}`);

  // 2) 必读文档存在、无 BOM
  for (const name of REQUIRED_DOCS) {
    const p = path.join(GUIDE_DIR, name);
    if (!fs.existsSync(p)) {
      problems.push(`缺少必读文档 docs/project-guide/${name}`);
      continue;
    }
    if (hasBom(p)) problems.push(`docs/project-guide/${name} 带 BOM（no-bom.test.ts 会红）`);
  }

  // 3) 版本必须出现在当前文档里
  for (const name of VERSION_DOCS) {
    const p = path.join(GUIDE_DIR, name);
    if (!fs.existsSync(p)) continue;
    if (!readText(p).includes(facts.version)) {
      problems.push(`docs/project-guide/${name} 没有当前版本 ${facts.version}（发版后忘了更新？）`);
    }
  }

  // 4) BASELINE 必须存在且版本一致
  const baseline = readBaseline();
  if (!baseline) {
    problems.push("缺少 docs/project-guide/BASELINE.json（先跑 npm run docs:sync）");
  } else if (baseline.version !== facts.version) {
    problems.push(`BASELINE.json 版本 ${baseline.version} ≠ package.json ${facts.version}（先跑 npm run docs:sync）`);
  }

  // 5) 索引完整性：README 必须列出所有必读文档
  const readmePath = path.join(GUIDE_DIR, "README.md");
  if (fs.existsSync(readmePath)) {
    const readme = readText(readmePath);
    for (const name of REQUIRED_DOCS) {
      if (!readme.includes(name)) problems.push(`README.md 没有索引 ${name}`);
    }
    if (!readme.includes("11-HANDOFF-PROMPT.md")) {
      problems.push("README.md 没有指向 11-HANDOFF-PROMPT.md（新 Agent 交接话术）");
    }
  }

  // 6) 当前状态文档必须有核心章节（防止被误删/改名后“看起来还有”）
  const currentPath = path.join(GUIDE_DIR, "09-CURRENT-STATE.md");
  if (fs.existsSync(currentPath)) {
    const t = readText(currentPath);
    for (const heading of ["## 1. 版本与发布", "## 5. 未完成 / 未验证"]) {
      if (!t.includes(heading)) problems.push(`09-CURRENT-STATE.md 缺少章节「${heading}」`);
    }
  }

  // 7) 计数只做警告：开发期会变，发版时 docs:sync 刷新
  if (baseline) {
    for (const key of ["testFiles", "coreDirs", "sqliteTables", "tauriCommandAnnotations"]) {
      if (typeof baseline[key] === "number" && baseline[key] !== facts[key]) {
        warnings.push(`BASELINE ${key}=${baseline[key]}，实际 ${facts[key]}（发版前跑 npm run docs:sync）`);
      }
    }
  }

  return { ok: problems.length === 0, problems, warnings, facts, baseline };
}

/** 写入 BASELINE.json（只写机器可算的基线；叙述性内容仍需人工更新）。 */
export function syncProjectGuide() {
  const facts = collectFacts();
  const payload = {
    _note: "由 tools/docs/update-project-guide.mjs --write 生成；发版时用于对齐文档基线。计数类信息只做警告，版本一致性是硬门禁。",
    ...facts,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return { facts, path: BASELINE_PATH };
}
