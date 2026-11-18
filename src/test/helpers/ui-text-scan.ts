/**
 * UI 文案/emoji 扫描器（Batch 0 的两条棘轮共用）。
 *
 * 为什么用 TypeScript 解析器而不是正则：
 *   ① 注释里 emoji 极多（JSDoc 里全是 ⚠️），正则必须"剥注释"，而自己写剥注释器要处理
 *      模板串/正则字面量/嵌套注释 —— 实测很容易把 `//` 出现在字符串里的行算错；
 *   ② 文案判定要区分「字符串字面量/JSX 文本」与「标识符/类名」。AST 天然分得清：
 *      `className="sidebar-nav-item"` 是字面量但不含 CJK，判据自然不受影响；
 *      而 `**对话级默认直接生效**` 这种写在 JSX 文本里的 raw Markdown 能被精确定位到行。
 *
 * 口径（写进 `tools/ui-audit/copy-guard-baseline.json` 的 `scope` 字段）：
 *   - 语料：`src/components/**`、`src/App.tsx`、`packages/ui/src/**`；
 *   - 排除：`*.test.*`、`src/plugins/monopoly-game/**`（游戏美术，约定本轮不动）；
 *   - 只统计 JSX 文本、字符串/模板字面量；注释不参与（解析器不产生注释节点）。
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** 语料根（相对仓库根） */
export const SURFACE_ROOTS = ["src/components", "src/App.tsx", "packages/ui/src"] as const;

/** 目录级排除（相对路径前缀） */
export const SURFACE_EXCLUDES = ["src/plugins/monopoly-game/"] as const;

/** emoji：pictographs + 常见彩色符号 + 变体选择符（不含 → ✓ ✗ 这类文字符号） */
const EMOJI_SOURCE =
  "[\\u{1F000}-\\u{1FAFF}\\u{2705}\\u{274C}\\u{2757}\\u{26A0}\\u{26A1}\\u{26D4}\\u{2699}\\u{269B}\\u{26F5}\\u{2B50}\\u{2B55}\\u{2708}\\u{2709}\\u{2728}\\u{2734}\\u{2744}\\u{2764}\\u{1F3FB}-\\u{1F3FF}]|\\uFE0F";
const EMOJI_RE = new RegExp(EMOJI_SOURCE, "gu");

/** 禁用词（DESIGN-DIRECTION §文案规则）：营销/口语/夸张 */
export const BANNED_WORDS = [
  "超级", "无缝", "丝滑", "魔法", "神器", "黑科技", "王炸", "颠覆", "革命性",
  "赋能", "解锁", "释放", "终极", "极致", "完美", "领先", "最强", "顶级",
  "秒级", "零门槛", "全自动", "智能化", "牛逼", "搞定", "咱们", "小伙伴",
  "主人", "悄悄", "偷偷", "放心", "一键", "开箱即用", "丝般",
] as const;

/** greeting（方向稿：不问候） */
export const GREETING_PATTERNS = [
  "欢迎回来", "欢迎使用", "你好呀", "你好啊", "准备好了吗", "准备好了，开始吧",
  "早上好", "上午好", "下午好", "晚上好", "嗨，", "哈喽",
] as const;

/** 感叹号：只认中文语境（`！` 或紧跟 CJK 的 `!`），避免把 `!token` / `!=` 算进来 */
const EXCLAMATION_RE = /[\u4e00-\u9fff][ \t]*[!！]|[！]/u;

/** raw Markdown：含 CJK 的文本里出现 `**…**`（正常渲染不该把标记露出来） */
const RAW_MARKDOWN_RE = /[\u4e00-\u9fff][^`]*\*\*[^*]+\*\*/u;

const CJK_RE = /[\u4e00-\u9fff]/u;

export interface TextHit {
  file: string;
  line: number;
  text: string;
}

export interface TextScan {
  /** 含 emoji 的文本节点数（按行去重） */
  emojiLines: number;
  emojiFiles: number;
  emojiByFile: Record<string, number>;
  copy: {
    banned: number;
    greeting: number;
    exclamation: number;
    rawMarkdown: number;
  };
  copyByFile: Record<string, { banned: number; greeting: number; exclamation: number; rawMarkdown: number }>;
  samples: {
    banned: TextHit[];
    greeting: TextHit[];
    exclamation: TextHit[];
    rawMarkdown: TextHit[];
  };
  filesScanned: number;
}

function listFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") continue;
      listFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
}

/** 语料清单（相对仓库根的 POSIX 路径） */
export function surfaceFiles(): string[] {
  const abs: string[] = [];
  for (const rel of SURFACE_ROOTS) {
    const full = path.join(REPO_ROOT, rel);
    const stat = fs.existsSync(full) ? fs.statSync(full) : null;
    if (!stat) continue;
    if (stat.isDirectory()) listFiles(full, abs);
    else abs.push(full);
  }
  return abs
    .map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/"))
    .filter((rel) => !SURFACE_EXCLUDES.some((prefix) => rel.startsWith(prefix)))
    .sort();
}

/** 收集一个文件里所有"用户可见文本候选"（JSX 文本 + 字符串/模板字面量） */
function collectTexts(rel: string, source: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string }> = [];
  const push = (node: ts.Node, text: string) => {
    if (!text) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ line, text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sf).replace(/\s+/g, " ").trim();
      if (text) push(node, text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // 跳过 import/require 的模块说明符与 CSS 类名这类"非文案"用途
      const parent = node.parent;
      const isModuleSpecifier =
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "require");
      if (!isModuleSpecifier) push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      // 模板串只看片段文字（表达式部分由它自己的字面量节点覆盖）
      for (const span of node.templateSpans) push(span.literal, span.literal.text);
      push(node.head, node.head.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 扫描整个 UI 语料 */
export function scanUiTexts(): TextScan {
  const files = surfaceFiles();
  const emojiByFile: Record<string, number> = {};
  const copyByFile: TextScan["copyByFile"] = {};
  const samples: TextScan["samples"] = { banned: [], greeting: [], exclamation: [], rawMarkdown: [] };
  const copy = { banned: 0, greeting: 0, exclamation: 0, rawMarkdown: 0 };

  for (const rel of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const texts = collectTexts(rel, source);

    // emoji：同一行只算一次（一个 badge 里 3 个 emoji 仍是一行要改的文案）
    const emojiLines = new Set<number>();
    for (const t of texts) {
      EMOJI_RE.lastIndex = 0;
      if (EMOJI_RE.test(t.text)) emojiLines.add(t.line);
    }
    if (emojiLines.size > 0) emojiByFile[rel] = emojiLines.size;

    for (const t of texts) {
      const bump = (rule: keyof TextScan["copy"]) => {
        copy[rule] += 1;
        copyByFile[rel] = copyByFile[rel] ?? { banned: 0, greeting: 0, exclamation: 0, rawMarkdown: 0 };
        copyByFile[rel][rule] += 1;
        if (samples[rule].length < 40) samples[rule].push({ file: rel, line: t.line, text: t.text.slice(0, 120) });
      };
      const word = BANNED_WORDS.find((w) => t.text.includes(w));
      if (word) bump("banned");
      if (GREETING_PATTERNS.some((g) => t.text.includes(g))) bump("greeting");
      if (CJK_RE.test(t.text) && EXCLAMATION_RE.test(t.text)) bump("exclamation");
      if (CJK_RE.test(t.text) && RAW_MARKDOWN_RE.test(t.text)) bump("rawMarkdown");
    }
  }

  return {
    emojiLines: Object.values(emojiByFile).reduce((a, b) => a + b, 0),
    emojiFiles: Object.keys(emojiByFile).length,
    emojiByFile,
    copy,
    copyByFile,
    samples,
    filesScanned: files.length,
  };
}
