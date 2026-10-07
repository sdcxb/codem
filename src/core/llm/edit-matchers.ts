/**
 * edit / multi_edit 的字符串匹配与替换工具函数。
 *
 * 本文件存在的唯一理由：**把「替换」这件事从 `String.prototype.replace` 的
 * 替换记号语义里救出来**，并在匹配失败时给出可行动的信息。
 *
 * ## 为什么需要 `replaceLiteral`
 *
 * `String.prototype.replace(search, replacement)` 在 `replacement` 是**字符串**
 * 时，会把下面四个记号当作模板展开：
 *
 * | 记号 | 展开为 |
 * | --- | --- |
 * | `$$` | 一个字面 `$` |
 * | `$&` | 被匹配到的原文 |
 * | `` $` `` | 匹配点**之前**的全部内容 |
 * | `$'` | 匹配点**之后**的全部内容 |
 *
 * 模型在 `newString` 里写出这些序列是完全正常的（正则、模板串、shell 变量），
 * 但结果是**文件内容被静默改写**，而工具仍然返回「Successfully edited」——
 * 这是数据损坏，不是编辑失败。
 *
 * 实测（`.preview-shot/_repro-edit-dollar.cjs`，oldString = `const b = 2;`）：
 * - `$&` → 实得 `const b = const b = 2;;`
 * - `$$` → 实得 `const b = "$";`
 * - `` $` `` → 实得 `const b = const a = 1;`
 * - `$'` → 实得匹配点之后的全部内容被再插入一次
 *
 * 修法是传**函数**而不是字符串：函数返回值不经过替换记号解析。
 * zcode 的对应实现也是这么做的（`tool/handlers/edit.ts:631-634`）。
 */

/** `String.replace` 会特殊解释的替换记号（仅用于诊断与测试断言）。 */
const REPLACEMENT_TOKEN_PATTERN = /\$(\$|&|`|')/g;

/**
 * 字面量替换：把 `content` 里第一处 `search` 换成 `replacement`，
 * `replacement` 内的 `$` 记号**不做任何展开**。
 *
 * ⚠️ 它**只换第一处**。出现多次时，改错地方与改对地方在返回文本上无法区分，
 * 所以需要「不许有歧义」的调用方（`edit` 工具）必须先问 `findAmbiguousLiteral`。
 *
 * @returns 替换后的内容；未命中时返回 `null`（调用方负责给模型错误信息）
 */
export function replaceLiteral(
  content: string,
  search: string,
  replacement: string,
): string | null {
  // 用 `!search` 而不是 `search === ""`：工具参数来自模型的 JSON，**缺字段时是
  // `undefined` 而不是空串**。`content.indexOf(undefined)` 会把 undefined 当字符串
  // "undefined" 去找（找不到，返回 -1），而 `content.slice(idx + undefined.length)`
  // 会直接抛 TypeError —— 于是「模型少给一个参数」会变成一条
  // 「Cannot read properties of undefined」的崩溃信息，而不是可行动的错误。
  // 见 `src/test/core-tool-execution.test.ts` 的 TOOL-004b：那条用例传的正是
  // 蛇形 `old_string`（工具要的是 `oldString`），历史上一直被这句崩溃掩盖。
  if (!search || typeof search !== "string") return null;
  const idx = content.indexOf(search);
  if (idx < 0) return null;
  // 用 slice 拼装而不是 String.replace：既规避 $& / $$ / $` / $' 的模板语义，
  // 也让「只替换一次」这件事在代码里显式可见。
  return content.slice(0, idx) + replacement + content.slice(idx + search.length);
}

/**
 * `search` 在 `content` 里出现的**全部**起始下标（非重叠，从左到右）。
 *
 * ## 为什么需要它（第 D8 波：`edit` 改错地方却报成功）
 *
 * `replaceLiteral` 只换第一处 —— 这正是它名字里的承诺。但当 `oldString` 在文件里
 * 出现两次以上时，**「第一处」未必是模型想改的那一处**，而工具照样写盘并返回
 * 「Successfully edited」。错误要等到 build/test 失败（或者用户看见别处被改坏）才暴露，
 * 而模型已经收到成功信号、多半继续往下走。
 *
 * 本文件的 `suggestEditCandidates`（见下方 `:229` 的设计取舍）已经写明原则：
 * 「候选值不唯一时明确说『有 N 处』，而不是挑一个」。**精确命中同样适用** ——
 * 挑第一处和挑一个候选，是同一个错误的两种写法。
 *
 * 空串 / 非字符串 `search` 返回 `[]`：与 `replaceLiteral` 开头的守卫同一判据
 * （模型漏字段时是 `undefined`，`content.indexOf(undefined)` 会去找字面量 "undefined"）。
 * `search` 非空时每次至少前进 `search.length` 个字符，因此不可能死循环。
 */
function findLiteralOccurrences(content: string, search: string): number[] {
  if (!search || typeof search !== "string") return [];
  const offsets: number[] = [];
  for (let from = 0; ; ) {
    const idx = content.indexOf(search, from);
    if (idx < 0) break;
    offsets.push(idx);
    from = idx + search.length;
  }
  return offsets;
}

export interface AmbiguousLiteralMatch {
  /** `search` 在文件里出现的次数（≥ 2） */
  count: number;
  /** 每处出现的 1-based 起始行号，顺序与 `findLiteralOccurrences` 一致 */
  lines: number[];
}

/**
 * `search` 在 `content` 里出现**多次**时给出「有几处、分别在哪几行」；否则返回 `null`
 * （0 处 = 未命中，1 处 = 无歧义，两者都由调用方按原逻辑处理）。
 *
 * 调用方（`edit` 工具）据此**拒绝写盘**，而不是挑第一处改掉。
 */
export function findAmbiguousLiteral(
  content: string,
  search: string,
): AmbiguousLiteralMatch | null {
  const offsets = findLiteralOccurrences(content, search);
  if (offsets.length <= 1) return null;
  return { count: offsets.length, lines: offsets.map((o) => lineNumberOf(content, o)) };
}

/**
 * 字面量全局替换：`multi_edit` 需要时使用。
 * 同样不做 `$` 记号展开。
 */
export function replaceLiteralAll(
  content: string,
  search: string,
  replacement: string,
): string | null {
  if (!search || typeof search !== "string") return null;
  if (!content.includes(search)) return null;
  return content.split(search).join(replacement);
}

/**
 * `replacement` 里是否含会被 `String.replace` 当成模板的记号。
 * 用于测试断言「我们的实现不受这些记号影响」，以及诊断日志。
 */
export function containsReplacementToken(replacement: string): boolean {
  REPLACEMENT_TOKEN_PATTERN.lastIndex = 0;
  return REPLACEMENT_TOKEN_PATTERN.test(replacement);
}

// ==================== 匹配失败时给可行动的候选 ====================

/**
 * 归一化层级。按「越靠前越不可能误匹配」排序，**首个命中即独占**，
 * 不做多级叠加（照 zcode `edit-matchers.ts:46-66` 的取向：保守优先）。
 */
const NORMALIZER_NAMES = [
  "crlf",
  "line_number_prefix",
  "trailing_whitespace",
  "quote_normalized",
  "indentation_flexible",
] as const;

export type NormalizerName = (typeof NORMALIZER_NAMES)[number];

/** 智能引号 → ASCII（模型常从渲染过的文本里复制出弯引号）。 */
const SMART_QUOTE_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/[\u2013\u2014]/g, "-"],
  [/\u00A0/g, " "],
];

function normalizeSmartQuotes(s: string): string {
  let out = s;
  for (const [re, to] of SMART_QUOTE_MAP) out = out.replace(re, to);
  return out;
}

/**
 * 单层归一化。
 *
 * 注意每一层都必须是**内容不变形的**文本变换，否则给了候选反而误导模型。
 */
export function normalizeFor(name: NormalizerName, s: string): string {
  switch (name) {
    case "crlf":
      return s.replace(/\r\n/g, "\n");
    case "line_number_prefix":
      // `read` 工具的输出行形如 `123: content` / `123→content`，
      // 模型有时把行号一起复制进 oldString。
      return s.replace(/^\s*\d+[:→\t]\s?/gm, "");
    case "trailing_whitespace":
      return s
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n");
    case "quote_normalized":
      return normalizeSmartQuotes(s);
    case "indentation_flexible":
      // 每行剥掉前导空白后比较 —— 只用于**给出候选**，绝不用于自动替换：
      // 缩进在 Python / YAML 里是语义，自动按这个层级替换会写出错代码。
      return s
        .split("\n")
        .map((l) => l.trimStart())
        .join("\n");
  }
}

/** 逐行相似度（1 - levenshtein / maxLen），仅用于给候选排序与展示。 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // 只保留两行做 DP，长文件也不炸内存
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

interface EditCandidate {
  /** 文件里真实存在的那段文本（已归一化到与 search 同形） */
  text: string;
  /** 1-based 起始行号 */
  line: number;
  /** 该候选的相似度（0–1） */
  similarity: number;
  /** 命中所需的归一化层级 */
  normalizer: NormalizerName;
}

export interface EditSuggestion {
  candidates: EditCandidate[];
  /** 给模型看的可行动文本 */
  message: string;
}

const MAX_CANDIDATES = 3;
const PREVIEW_CHARS = 300;
/** 低于这个相似度的候选不值得占 token。 */
const MIN_SIMILARITY = 0.6;
/** 超过这个长度就不做 O(n·m) 的相似度扫描了，退化为「只报层级命中」。 */
const MAX_SIMILARITY_SCAN = 20_000;

/**
 * 文件行数。
 *
 * 用「换行符个数」而不是 `split("\n").length` —— 后者对以换行结尾的文件
 * （绝大多数源文件）会多算一行，而且与本文件里 `lineNumberOf()` 的口径不一致，
 * 导致同一份文件在候选行号和「文件共 N 行」提示里出现两个数字。
 */
function countLines(content: string): number {
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") n++;
  }
  // 以换行结尾时最后一行是空的，不计数
  if (content.endsWith("\n")) n--;
  return n;
}

function lineNumberOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function preview(text: string): string {
  const one = text.replace(/\n/g, "\\n");
  return one.length > PREVIEW_CHARS ? one.slice(0, PREVIEW_CHARS) + "…" : one;
}

/**
 * `edit` 的 `oldString` 没命中时，找出「模型大概想改哪里」。
 *
 * 设计取舍（照 zcode：保守优先、歧义即拒）：
 * - 只**报告**候选，不自动替换。自动按归一化层级替换会在缩进敏感语言里写出错代码。
 * - 候选值不唯一时明确说「有 N 处」，而不是挑一个。
 * - 候选全都不像时老实说「找不到相似内容」，并给出文件规模供模型判断。
 *
 * @returns `null` 表示连候选都给不出（调用方退回原来的简短错误）
 */
export function suggestEditCandidates(
  content: string,
  search: string,
): EditSuggestion | null {
  if (search.length === 0) return null;

  const found = new Map<string, EditCandidate>();

  // 第一优先：归一化后精确命中 —— 这类候选一定存在，且相似度 1。
  for (const name of NORMALIZER_NAMES) {
    const nc = normalizeFor(name, content);
    const ns = normalizeFor(name, search);
    if (ns.length === 0) continue;
    const idx = nc.indexOf(ns);
    if (idx < 0) continue;
    // 同一段文本可能被多个层级命中；NORMALIZER_NAMES 已按「越靠前越不可能误匹配」排序，
    // 因此保留首次命中的层级，后续层级不再覆盖。
    if (found.has(ns)) continue;
    found.set(ns, {
      text: ns,
      line: lineNumberOf(nc, idx),
      similarity: 1,
      normalizer: name,
    });
  }

  // 第二优先：逐行相似度 —— 只在文件不大时做，避免 DP 成本失控。
  if (found.size === 0 && content.length <= MAX_SIMILARITY_SCAN) {
    const contentLines = content.split("\n");
    const searchLines = search.split("\n");
    const target = searchLines[0].trim();
    if (target.length >= 4) {
      const scored = contentLines
        .map((l, i) => ({
          line: i + 1,
          raw: l,
          sim: lineSimilarity(l.trim(), target),
        }))
        .filter((x) => x.raw.trim().length > 0 && x.sim >= MIN_SIMILARITY)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, MAX_CANDIDATES);
      for (const s of scored) {
        const text = contentLines
          .slice(s.line - 1, s.line - 1 + searchLines.length)
          .join("\n");
        if (!found.has(text)) {
          found.set(text, {
            text,
            line: s.line,
            similarity: s.sim,
            normalizer: "indentation_flexible",
          });
        }
      }
    }
  }

  if (found.size === 0) {
    const totalLines = countLines(content);
    return {
      candidates: [],
      message:
        `oldString not found, and no similar content was found. ` +
        `The file has ${totalLines} lines / ${content.length} chars. ` +
        `Re-read the target region with read (offset/limit) and copy the exact text, ` +
        `or use write if the change is large.`,
    };
  }

  const candidates = [...found.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CANDIDATES);

  const lines: string[] = [
    `oldString not found. ${candidates.length} similar passage(s) exist in the file:`,
    "",
  ];
  candidates.forEach((c, i) => {
    const why =
      c.similarity === 1
        ? `exact after ${c.normalizer} normalization`
        : `~${(c.similarity * 100).toFixed(0)}% similar`;
    lines.push(`${i + 1}. line ${c.line} (${why}):`);
    lines.push(`   ${preview(c.text)}`);
  });
  lines.push("");
  lines.push(
    `Retry edit with one of the passages above copied verbatim (including its original indentation), ` +
      `or re-read the region first with read. Do NOT guess the whitespace.`,
  );

  return { candidates, message: lines.join("\n") };
}
