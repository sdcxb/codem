/**
 * `BENCH-EVIDENCE-1`：对标取证必须在**仓库里**、且结论能指回仓库内的文件（GAP-LIST `O-54`）。
 *
 * ## 这条判据要守的是什么
 *
 * `O-54` 的根因不是「没做取证」，而是「取证做了、证据不在仓库里」：
 * 三份对标只读取证（OpenClaw 源码 / Hermes 源码 / 三家落点）与 DSH reminder 取证全部落在
 * `.preview-shot/`，而该目录在 `.gitignore` 内 ⇒ **clone 下来的人看不到任何证据**，
 * 仓库里的文字记录只剩 `docs/HANDOFF-NEXT-SESSION.md` 第 189 波 §二 的摘要。
 * 照摘要下结论 = 本仓最忌的「不可复核」。
 *
 * 所以本文件钉四件事（外加一条「真的在仓库里」）：
 *
 * | 编号 | 判据 | 反向对照 |
 * | --- | --- | --- |
 * | `BE-1` | `docs/BENCH-EVIDENCE.md` 存在；**至少 3 份**对标素材被引用；每份都出现在**带等级标记**（`确证`/`疑似`/`不可用`）的同一行；等级行总数 ≥ 10 | 变异 `MUT-1`（去掉 A 组两行素材索引）⇒ 红 |
 * | `BE-2` | `docs/` 递归下的 `.md` 里提到原始长文目录的文件，必须在**同一文件**里指到一个**可解析**的仓库内路径；对标结论的载体还要**段级 / 表格行级**自洽；例外表逐条登记且**不许过期** | `BE-3` 用**伪造的坏文档 / 过期例外**证明它判红 |
 * | `BE-3` | 判定逻辑是**纯函数**，坏样本必红、好样本必绿（不是恒真） | 好文档（同段指了 `src/...`）必须**不**被判红 |
 * | `BE-4` | 凡「命中率 + 不可观测」的句子必须写明是**对标三家**（`O-54` ③ 的原话是「三家…不可观测」）；且必须给出**我方**读法 `[prompt-cache]` 与替代口径的边界（客户端字节 ≠ 服务端 token，不能互相换算） | 变异 `MUT-2`（改写成一句无主语的话）⇒ 红 |
 * | `BE-5` | 三处缺口现状（`GRAPH MEMORY` 退役 / `references/system-prompt-invariant.md` 本地没有 / Hermes 未跑测试 + 文档自相矛盾）必须在场；且本文件**真的在仓库里**（`git check-ignore` 退出码 1） | 变异 `MUT-4`（删掉 `.gitignore` 白名单）⇒ 红；对照：原始长文目录是刻意忽略的（退出码 0） |
 *
 * ## 为什么 `BE-2` 分两级（这一点是被实测逼出来的）
 *
 * 落库时实测：`docs/` 递归下的 `.md` 里提到原始长文目录的共 **32 份**，其中要做**段级**自洽会有 **26 份 / 144 段**不满足
 * （历史工程日志里的命令块、只贴脚本名的短段比比皆是）。历史长文**不可能逐段重写** ⇒
 * 全仓只要求**文件级**自洽（同一文件里指到一个仓库内文件即可），而**对标结论的载体**
 * （`docs/BENCH-EVIDENCE.md` 自己）要求**段级 / 表格行级**自洽 —— 这样「只指原始长文目录的一段结论」仍旧会被判红，
 * 同时不去动别人的历史记录。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const BENCH_REL = "docs/BENCH-EVIDENCE.md";
const BENCH_DOC = path.join(ROOT, ...BENCH_REL.split("/"));
const TEST_REL = "src/test/docs-bench-evidence.test.ts";

/** `O-54` 的四份对标素材（都在原始长文目录内、**不进仓库**） */
export const BENCH_MATERIALS = [
  "_bench-openclaw-src.md",
  "_bench-hermes-src.md",
  "_bench-memory-placement.md",
  "_dsh-reminder-lifecycle.md",
] as const;

/** 原始长文目录（`.gitignore` 内）。判据里只写这一次，别处都拼它 —— 免得「换个目录名」时漏改一处 */
const PREVIEW_DIR = ".preview-shot/";

/** 等级只有三档（`O-54` 要求逐条标「确证 / 疑似」，`不可用` 是本轮补的第三档） */
const LEVEL_MARKS = ["确证", "疑似", "不可用"] as const;

/** 需要**段级 / 表格行级**自洽的文件：对标结论的载体 */
export const STRICT_POINTER_FILES = [BENCH_REL];

/** 仓库内路径的顶层前缀（这些前缀下的**存在**路径才算「指到一个仓库内文件」） */
const REPO_PREFIXES = ["src", "docs", "tools", "src-tauri", "scripts"];
/** 顶层文件也算（`AGENTS.md`、`package.json` 这类） */
const REPO_TOP_FILES = [
  "AGENTS.md",
  "package.json",
  "CHANGELOG.md",
  "tsconfig.json",
  "README.md",
  "vite.config.ts",
  ".gitignore",
];

// ===================== 纯函数（`BE-3` 拿伪造文档直接调它们） =====================

/**
 * 从一段文本里抽出「指向仓库内」的路径。
 *
 * ⚠️ 两条刻意的严格：
 * 1. **必须真的存在**（`exists` 由调用方给，判据里是 `fs.existsSync`）—— 只写形状不算指针；
 * 2. 只有顶层目录名的（`docs/`、`src/`）**不算** —— 否则一句「见 `src/`」就能骗过判据。
 */
export function repoInternalRefs(text: string, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:^|[^A-Za-z0-9._/-])((?:${REPO_PREFIXES.join("|")})\\/[A-Za-z0-9._/-]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1].replace(/[.,;:)\]}]+$/, "");
    const parts = tok.split("/");
    if (parts.length < 2 || parts.slice(1).join("").length === 0) continue;
    if (!/[^/]/.test(parts.slice(1).join("/"))) continue;
    if (exists(tok)) out.push(tok);
  }
  for (const f of REPO_TOP_FILES) if (text.includes(f)) out.push(f);
  return [...new Set(out)];
}

export interface DocUnit {
  /** 段内序号（便于报错时定位） */
  index: number;
  kind: "block" | "table-row";
  text: string;
}

/**
 * 把一份文档切成「判定单位」：空行分隔的段；**表格的每一行各自算一个单位**
 * （否则一个 20 行的表会被当成一段，某一行只指原始长文目录也看不出来）。
 */
export function textUnits(text: string): DocUnit[] {
  const units: DocUnit[] = [];
  const blocks = text.split(/\r?\n\s*\r?\n/);
  blocks.forEach((block, bi) => {
    const lines = block.split(/\r?\n/);
    const tableLines = lines.filter((l) => l.trimStart().startsWith("|"));
    if (tableLines.length >= 2) {
      for (const tl of tableLines) units.push({ index: bi, kind: "table-row", text: tl });
      const rest = lines.filter((l) => !l.trimStart().startsWith("|")).join("\n");
      if (rest.trim().length > 0) units.push({ index: bi, kind: "block", text: rest });
    } else {
      units.push({ index: bi, kind: "block", text: block });
    }
  });
  return units;
}

export interface PreviewPointerIssue {
  rel: string;
  kind: "file" | "unit";
  why: string;
  snippet: string;
}

export interface PreviewPointerReport {
  /** 扫到的 `docs/` 递归下 `.md` 的份数（防空集假绿） */
  scanned: number;
  /** 其中提到原始长文目录的份数 */
  withPreview: number;
  issues: PreviewPointerIssue[];
  /** 例外表里**已经不需要**的登记（过期 ⇒ 必须删行） */
  staleExceptions: string[];
  exceptions: Record<string, string>;
}

/**
 * `BE-2` 的核心判定（纯函数）。
 *
 * - 文件级：提到原始长文目录 ⇒ 同一文件里必须有一个**可解析**的仓库内路径；
 * - 单位级：`strictFiles` 里的文件还要每一段 / 每一表格行自带仓库内路径；
 * - 例外表：登记项必须仍然**必要**（文件还在、还提该目录、且确实还缺指针）—— 否则算过期。
 */
export function auditPreviewPointers(
  docs: Array<{ rel: string; text: string }>,
  opts: {
    exists: (rel: string) => boolean;
    exceptions?: Record<string, string>;
    strictFiles?: string[];
    previewDir?: string;
  },
): PreviewPointerReport {
  const previewDir = opts.previewDir ?? PREVIEW_DIR;
  const exceptions = opts.exceptions ?? {};
  const strictFiles = opts.strictFiles ?? [];
  const byRel = new Map(docs.map((d) => [d.rel, d.text]));
  const issues: PreviewPointerIssue[] = [];
  let withPreview = 0;

  for (const doc of docs) {
    if (!doc.text.includes(previewDir)) continue;
    withPreview += 1;
    const refs = repoInternalRefs(doc.text, opts.exists);
    const unitIssues = strictFiles.includes(doc.rel)
      ? textUnits(doc.text)
          .filter((u) => u.text.includes(previewDir) && repoInternalRefs(u.text, opts.exists).length === 0)
          .map((u) => ({
            rel: doc.rel,
            kind: "unit" as const,
            why: `这一段 / 这一表格行只提原始长文目录，没有仓库内指针（${u.kind} #${u.index}）`,
            snippet: u.text.trim().slice(0, 120),
          }))
      : [];
    if (exceptions[doc.rel] !== undefined) continue; // 登记过的例外（过期与否在下面单独算）
    if (refs.length === 0) {
      issues.push({
        rel: doc.rel,
        kind: "file",
        why: "整个文件里没有一个可解析的仓库内路径 —— 只指原始长文目录（clone 下来的人看不到证据）",
        snippet: doc.text.trim().slice(0, 120),
      });
    }
    issues.push(...unitIssues);
  }

  const staleExceptions: string[] = [];
  for (const rel of Object.keys(exceptions)) {
    const text = byRel.get(rel);
    if (text === undefined || !text.includes(previewDir)) {
      staleExceptions.push(`${rel}（已不再提原始长文目录 ⇒ 登记过期，删掉这一行）`);
      continue;
    }
    const refs = repoInternalRefs(text, opts.exists);
    const unitIssues = strictFiles.includes(rel)
      ? textUnits(text).filter((u) => u.text.includes(previewDir) && repoInternalRefs(u.text, opts.exists).length === 0)
      : [];
    if (refs.length > 0 && unitIssues.length === 0) {
      staleExceptions.push(`${rel}（已补上仓库内指针 ⇒ 登记过期，删掉这一行）`);
    }
  }

  return { scanned: docs.length, withPreview, issues, staleExceptions, exceptions };
}

/** 从 `docs/BENCH-EVIDENCE.md` 的「例外表」解析登记项（第一列必须是 `docs/….md` 才算登记项） */
export function parseExceptions(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.includes("例外表"));
  if (start < 0) return {};
  const out: Record<string, string> = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const file = (cells[1] ?? "").replace(/^`|`$/g, "");
    if (!/^docs\/[^\s|`]+\.md$/.test(file)) continue; // 占位行（「当前为空」）不是登记项
    out[file] = (cells[2] ?? "").replace(/^`|`$/g, "");
  }
  return out;
}

export interface BenchCitationReport {
  cited: string[];
  markedLines: number;
  /** 被引用、但没有任何「带等级标记的同一行」的素材 */
  materialsWithoutMark: string[];
}

/** `BE-1` 的核心：素材引用 + 等级标记必须同段（这里按**同一行**判，比「同一段」更严） */
export function auditBenchCitations(text: string, materials: readonly string[] = BENCH_MATERIALS): BenchCitationReport {
  const lines = text.split(/\r?\n/);
  const hasMark = (l: string) => LEVEL_MARKS.some((m) => l.includes(m));
  const cited = materials.filter((f) => text.includes(f));
  const materialsWithoutMark = cited.filter((f) => !lines.some((l) => l.includes(f) && hasMark(l)));
  return { cited: [...cited], markedLines: lines.filter(hasMark).length, materialsWithoutMark };
}

export interface KvObservabilityReport {
  /** 「命中率…不可观测」但没写清是哪三家的句子（假陈述形态） */
  violations: Array<{ line: number; sentence: string }>;
  /** 句子里的限定词（说明它说的是对标三家，不是我方） */
  qualifierInDoc: boolean;
}

/**
 * `BE-4` 的核心：`O-54` ③ 的原话是「**三家**服务端 KV 命中率不可观测」。
 * 把它写成一句没有主语的「KV 命中率不可观测」就是**假陈述**（我们自己的链路可观测，
 * 见 `src/core/llm/cache-percent.ts` 的 `[prompt-cache]` 日志）。
 */
export function auditKvObservability(text: string): KvObservabilityReport {
  const QUALIFIER = /(三家|对标|OpenClaw|Hermes|DSH)/;
  const violations: Array<{ line: number; sentence: string }> = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const sentence of line.split(/[。；;\n]/)) {
      if (sentence.includes("不可观测") && sentence.includes("命中率") && !QUALIFIER.test(sentence)) {
        violations.push({ line: i + 1, sentence: sentence.trim().slice(0, 120) });
      }
    }
  });
  return { violations, qualifierInDoc: QUALIFIER.test(text) };
}

// ===================== 判据用的真实数据 =====================

const existsRepoPath = (rel: string) => existsSync(path.join(ROOT, rel));

function scanDocs(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) {
        out.push({ rel: path.relative(ROOT, full).split(path.sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(DOCS);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const benchText = () => readFileSync(BENCH_DOC, "utf8");

describe("BENCH-EVIDENCE-1：对标取证的带出处摘要必须在仓库里（O-54）", () => {
  it("BE-1: `docs/BENCH-EVIDENCE.md` 存在，至少引 3 份对标素材且每份都带等级标记", () => {
    expect(existsSync(BENCH_DOC), "对标取证摘要必须落进仓库（不是只在报告里写一句）").toBe(true);
    const text = benchText();
    const report = auditBenchCitations(text);
    expect(
      report.cited.length,
      `至少引用 3 份对标素材（实到 ${report.cited.length} 份：${report.cited.join("、")}）`,
    ).toBeGreaterThanOrEqual(3);
    expect(report.materialsWithoutMark, "每份素材都必须出现在带等级标记（确证/疑似/不可用）的同一行").toEqual([]);
    expect(report.markedLines, "带等级标记的行 ≥ 10（防止「结论表被清空」也照样绿）").toBeGreaterThanOrEqual(10);

    // 反向对照：判据不是「任何文件名都算素材」—— 只认登记的那四份，别的一律不算
    const forged = auditBenchCitations("结论：某素材 `_bench-not-registered.md` 说 X（确证）。");
    expect(forged.cited, "未登记的素材名不算引用").toEqual([]);
    expect(auditBenchCitations("结论：没有素材也没有等级。").markedLines, "没有等级标记就不该被数到").toBe(0);
  });

  it("BE-2: `docs/**/*.md` 提原始长文目录的文件必须在同一文件里指到仓库内文件；本文件还要段级自洽", () => {
    const text = benchText();
    const report = auditPreviewPointers(scanDocs(), {
      exists: existsRepoPath,
      exceptions: parseExceptions(text),
      strictFiles: STRICT_POINTER_FILES,
    });
    expect(report.scanned, "扫描面不许为空（空集会让这条判据恒真）").toBeGreaterThanOrEqual(20);
    expect(report.withPreview, "必须真的扫到一批提到原始长文目录的文档").toBeGreaterThanOrEqual(10);
    // 例外表必须真的存在（否则 parseExceptions 返回 {} 也会"通过"）
    expect(text, "必须有例外表一节（规则写在里面）").toContain("例外表");
    expect(text, "例外表当前为空时必须写明（读者才知道「没有豁免」）").toContain("当前为空");
    expect(
      report.issues.map((i) => `${i.rel} [${i.kind}] ${i.why} :: ${i.snippet}`),
      "这些文件/段落只指原始长文目录，clone 下来的人看不到证据",
    ).toEqual([]);
    expect(report.staleExceptions, "例外表不许过期（登记项必须仍然必要）").toEqual([]);
  });

  it("BE-3: 纯函数的反向对照 —— 坏文档必红、好文档必绿", () => {
    /** 只认这一个仓库内路径的桩（`BE-3` 不该依赖磁盘状态） */
    const exists = (rel: string) => rel === TEST_REL;

    // ① 文件级：整份文档只指原始长文目录 ⇒ 红
    const badFile = auditPreviewPointers(
      [{ rel: "docs/FAKE-only-preview.md", text: `结论：易变侧公共前缀 97.67%。\n原始长文：\`${PREVIEW_DIR}_bench-hermes-src.md\`。\n` }],
      { exists },
    );
    expect(badFile.issues.length, "只指原始长文目录的文档必须判红").toBe(1);
    expect(badFile.issues[0].kind).toBe("file");

    // ② 同一个文件里指了仓库内文件 ⇒ 不判红
    const goodFile = auditPreviewPointers(
      [
        {
          rel: "docs/FAKE-with-pointer.md",
          text: `结论：易变侧公共前缀 97.67%（口径与判据见 \`${TEST_REL}\`）。\n原始长文：\`${PREVIEW_DIR}_bench-hermes-src.md\`。\n`,
        },
      ],
      { exists },
    );
    expect(goodFile.issues, "指了仓库内文件就不该判红（否则判据是恒红）").toEqual([]);

    // ③ 单位级：严格文件里「多加一段只指原始长文目录的结论」⇒ 红（这正是变异 MUT-3 的形态）
    const strictDoc = `# 标题\n\n一句话（判据见 \`${TEST_REL}\`）。\n\n| # | 结论 |\n| --- | --- |\n| 1 | 只指 \`${PREVIEW_DIR}_bench-openclaw-src.md\`（确证） |\n`;
    const strictBad = auditPreviewPointers([{ rel: BENCH_REL, text: strictDoc }], {
      exists,
      strictFiles: [BENCH_REL],
    });
    expect(strictBad.issues.filter((i) => i.kind === "unit").length, "表格行只指原始长文目录 ⇒ 判红").toBe(1);
    const strictGood = auditPreviewPointers(
      [{ rel: BENCH_REL, text: strictDoc.replace("（确证）", `（确证；依据 \`${TEST_REL}\`）`) }],
      { exists, strictFiles: [BENCH_REL] },
    );
    expect(strictGood.issues, "同一表格行补上仓库内指针 ⇒ 不判红").toEqual([]);
    // 反向对照：非严格文件不做段级判定（否则 26 份历史长文 / 144 段全都要重写）
    const loose = auditPreviewPointers([{ rel: "docs/FAKE-history.md", text: strictDoc }], { exists });
    expect(loose.issues.filter((i) => i.kind === "unit"), "非严格文件只做文件级判定").toEqual([]);

    // ④ 例外表：仍在提原始长文目录且确实缺指针 ⇒ 不算过期；已补指针 / 已不再提 ⇒ 算过期
    const stillNeeded = auditPreviewPointers(
      [{ rel: "docs/FAKE-history.md", text: `见 \`${PREVIEW_DIR}_bench-hermes-src.md\`。\n` }],
      { exists, exceptions: { "docs/FAKE-history.md": "历史工程日志（理由）" } },
    );
    expect(stillNeeded.issues, "登记过的例外本身不报").toEqual([]);
    expect(stillNeeded.staleExceptions, "仍然必要的登记不算过期").toEqual([]);
    const staleByPointer = auditPreviewPointers(
      [{ rel: "docs/FAKE-history.md", text: `见 \`${PREVIEW_DIR}_bench-hermes-src.md\` 与 \`${TEST_REL}\`。\n` }],
      { exists, exceptions: { "docs/FAKE-history.md": "历史工程日志（理由）" } },
    );
    expect(staleByPointer.staleExceptions.length, "已补上仓库内指针 ⇒ 登记过期").toBe(1);
    const staleByGone = auditPreviewPointers([{ rel: "docs/FAKE-history.md", text: "已经不提那个目录了。\n" }], {
      exists,
      exceptions: { "docs/FAKE-history.md": "历史工程日志（理由）" },
    });
    expect(staleByGone.staleExceptions.length, "已不再提原始长文目录 ⇒ 登记过期").toBe(1);

    // ⑤ 解析：占位行（「当前为空」）不是登记项
    expect(parseExceptions("## 五、例外表\n\n| 文件 | 理由 | 波次 |\n| --- | --- | --- |\n| （当前为空） | 没有例外 | — |\n")).toEqual({});
    expect(
      parseExceptions("## 五、例外表\n\n| 文件 | 理由 | 波次 |\n| --- | --- | --- |\n| `docs/FAKE-history.md` | 历史日志 | 191 |\n"),
    ).toEqual({ "docs/FAKE-history.md": "历史日志" });
  });

  it("BE-4: 「三家不可观测」不许写成「KV 命中率不可观测」，且必须给出我方读法 `[prompt-cache]`", () => {
    const text = benchText();
    const report = auditKvObservability(text);
    expect(report.violations, "这句是假陈述：对标三家不可观测，但**我们自己的**可观测").toEqual([]);
    expect(report.qualifierInDoc, "文档里必须出现限定词（三家 / 对标 / 三家名字）").toBe(true);

    // 我方口径必须写出来（否则读者会以为「命中率没人能量」）
    for (const needle of ["[prompt-cache]", "cacheHitTokens", "prompt_cache_hit_tokens", "formatPromptCacheLog"]) {
      expect(text, `必须给出我方读法 / 归一化口径：${needle}`).toContain(needle);
    }
    for (const needle of ["公共前缀", "客户端字节", "服务端 token", "不能互相换算"]) {
      expect(text, `必须写清替代口径与它的边界：${needle}`).toContain(needle);
    }
    expect(text, "缺报读法必须写明（不许编造 0）").toContain("hit=?");

    // 反向对照：伪造的坏句子必红、带限定词的好句子必绿
    expect(auditKvObservability("服务端 KV 命中率不可观测。").violations.length, "无主语的断言必须判红").toBe(1);
    expect(
      auditKvObservability("对标三家（OpenClaw / Hermes / DSH）的服务端 KV 命中率不可观测。").violations,
      "写明是三家 ⇒ 不判红",
    ).toEqual([]);
    expect(auditKvObservability("我们自己的服务端 KV 命中率可观测。").violations, "「可观测」不是违规").toEqual([]);
  });

  it("BE-5: 三处缺口现状必须在场，且本文件真的在仓库里（不许被 .gitignore 吞掉）", () => {
    const text = benchText();
    const lines = text.split(/\r?\n/);

    // ① OpenClaw `[GRAPH MEMORY]` 已退役
    expect(text, "必须写明 `[GRAPH MEMORY]`").toContain("GRAPH MEMORY");
    expect(text, "必须写明「已退役」（这是本条唯一能确证的事）").toContain("退役");
    // ② `references/system-prompt-invariant.md` = 上游文件、本地没有 ⇒ 不可用
    const invariantLine = lines.find(
      (l) => l.includes("references/system-prompt-invariant.md") && l.includes("不可用") && l.includes("上游"),
    );
    expect(invariantLine, "必须有一行同时写清：上游文件 + 本地没有 + 等级 `不可用`").toBeTruthy();
    expect(invariantLine!, "必须写清**本地没有**（否则会被当成证据）").toMatch(/本地|没有|不存在/);
    expect(invariantLine!, "等级必须是 `不可用`").toContain("不可用");
    // ③ Hermes 未跑测试 + 文档层序自相矛盾
    expect(text, "必须写明 Hermes 未执行任何测试").toContain("未执行任何测试");
    expect(text, "必须写明「未跑测试」").toContain("未跑测试");
    expect(text, "必须写明文档层序自相矛盾").toContain("自相矛盾");

    // ④ 真的在仓库里：`git check-ignore -q` 退出码 1 = 没被忽略（0 = 被忽略）
    const probe = spawnSync("git", ["check-ignore", "-q", BENCH_REL], { cwd: ROOT, encoding: "utf8" });
    expect(
      probe.status,
      `${BENCH_REL} 被 .gitignore 忽略了 —— 那这份「落进仓库」的取证在 clone 里根本不存在（要加 \`!docs/BENCH-EVIDENCE.md\` 白名单）`,
    ).toBe(1);
    // 反向对照：原始长文目录是**刻意忽略**的（退出码 0）—— 证明上面那条不是恒真
    const control = spawnSync("git", ["check-ignore", "-q", PREVIEW_DIR], { cwd: ROOT, encoding: "utf8" });
    expect(control.status, `对照项：原始长文目录是刻意忽略的，必须被判为忽略（退出码 0）`).toBe(0);
  });
});
