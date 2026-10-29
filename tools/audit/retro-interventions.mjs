#!/usr/bin/env node
/**
 * 复盘只读报告（P2-8）—— 从**本地会话史**里找出"用户一直在当人工环节"的地方。
 *
 * ## 这个工具回答什么问题
 *
 * 不是"这次会话出了什么错"（那是 `src/core/llm/postmortem.ts`，错误触发、按会话），
 * 而是"**同一种人工介入**是不是反复出现"：
 *
 * | 角色 | 用户在干什么 | 典型话 |
 * | --- | --- | --- |
 * | retry | 卡住/失败后让 agent 再来一次 | 「再试一次」「继续」「还是不行」 |
 * | judge | 判断输出好不好（agent 自己判不了） | 「太长」「重写」「太生硬」 |
 * | approve | 给 agent 等的那个"可以" | 「可以」「好的」「go ahead」 |
 * | carry | 把 agent 本该自己找到的上下文递过去 | 「上次」「另一个会话」「前面说过」 |
 * | trigger | 手动开同一类任务 | 多个会话的**开场白**高度相同 |
 * | stand-in | 做了 agent 本可以做的事 | 「我手动」「帮你登录」「复制过去」 |
 *
 * 一条反复出现的介入，就是一个可以**落到产物**的候选：一条规则、一个技能、一个脚本、
 * 一个定时任务，或者一句"这块只能人来"的说明。工具只产出**报告**，不提议改哪个文件、
 * 更不自动改 —— 拍板是人的事（mcode-stack `lifting-loops` 的退出顺序值得抄：
 * 先删陈旧规则 → 改现有产物 → 机械化检查 → 新技能 → 自动触发 → 全局规则 → 建议）。
 *
 * ## 为什么是启发式，以及为什么它必须"宁缺毋滥"
 *
 * 关键词分类天然会误判（「继续」可能是重试，也可能是批准）。所以：
 * - 短消息才参与 approve/judge 判定；
 * - 每条命中都带**原文片段**（截断 60 字、默认抹掉绝对路径），让人自己复核；
 * - 报告只给**候选**，不给结论；不写任何文件，除非显式 `--out`。
 *
 * ## 数据与隐私
 *
 * 只读 `sessions/*.jsonl`（权威副本，见 `docs/project-guide/06-DATA-STORAGE.md`）。
 * 不发网络、不改库、不删文件。默认跳过 `sub-` 前缀的内部会话（那些不是人的介入）。
 *
 * ## 用法
 *
 * ```powershell
 * node tools/audit/retro-interventions.mjs                 # 默认数据根，打印到 stdout
 * node tools/audit/retro-interventions.mjs --since 2026-10-01 --out .preview-shot/retro.md
 * node tools/audit/retro-interventions.mjs --json          # 机器可读
 * ```
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 六个介入角色（与 mcode-stack 的 lifting-loops 术语对齐，便于跨工具理解） */
export const ROLES = ["retry", "judge", "approve", "carry", "trigger", "stand-in"];

/** 示例片段最多留多少字 */
export const EXAMPLE_MAX_CHARS = 60;
/** 内部会话前缀（子代理 / 委派会话），默认不计入人的介入 */
const INTERNAL_SESSION_PREFIX = "sub-";

const PATTERNS = [
  {
    role: "retry",
    // 开头就是"再来一次"；或句中出现"还是不行/又失败"。
    // 中文分支**不能**用 \b：JS 的 \w 只认 ASCII，中文后面根本没有词边界（实测漏判）。
    test: (t) =>
      /^(再来|再做一次|重试|重新试|继续|接着|往下)(?![\u4e00-\u9fa5])/u.test(t) ||
      /^(retry|try again|continue|keep going|go on)\b/iu.test(t) ||
      /(还是不行|又失败|没成功|没搞定|still (failing|broken)|didn'?t work|doesn'?t work)/iu.test(t),
  },
  {
    role: "carry",
    // 必须是"递上下文"的说法；单独的「之前」太宽（系统提醒里到处都是），不收
    test: (t) =>
      /(上次(说|提|的|那个)|之前(说|提|那个|的会话)|另一个会话|前面(说|提)|我(发|提|说)过|earlier (i|we)|as i said|another session|we discussed)/iu.test(t),
  },
  {
    role: "stand-in",
    test: (t) =>
      /(我手动|我自己|帮你登录|复制过去|手动点|我来弄|manually|i'?ll do it myself|i clicked)/iu.test(t),
  },
  {
    role: "judge",
    test: (t) =>
      t.length <= 120 &&
      /(太长|太啰嗦|太生硬|不够好|重写|换个语气|改一下语气|太正式|too long|too verbose|too formal|rewrite)/iu.test(t),
  },
  {
    role: "approve",
    // 只认"短到就是一个点头"的消息
    test: (t) =>
      t.length <= 20 &&
      /^(可以|好的?|行|嗯|对|没问题|批准|同意|开始吧|做吧|继续吧|ok|okay|yes|yep|go ahead|approved|lgtm)[。.!！,，\s]*$/iu.test(t),
  },
];

/**
 * 不是人的话：平台/工具注入的提醒也以 `role: "user"` 落库。
 *
 * 真机教训（本工具第一次跑出来的样子）：同一条「[SYSTEM] 你改动了文件但没验证」
 * 被当成 11 次 carry 介入 —— 计数全是假的。这类文本必须整类排除，
 * 而不是靠调关键词去躲。
 */
const NON_HUMAN_PREFIXES = [
  "[SYSTEM]",
  "[系统]",
  "[子智能体",
  "[SUBAGENT",
  "[SUBAGENT SETTLEMENT",
  "[工具",
  "[tool",
  "<system-reminder>",
];

function isHumanMessage(content) {
  const text = String(content ?? "").trim();
  if (!text) return false;
  const upper = text.toUpperCase();
  return !NON_HUMAN_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

/** 抹掉绝对路径（报告可能被贴进文档，别把本机路径带出去） */
export function redactPaths(text) {
  return String(text ?? "")
    .replace(/[A-Za-z]:\\[^\s"'<>|]+/gu, "<path>")
    .replace(/\/(?:Users|home|mnt|opt|var|tmp)\/[^\s"'<>|]+/gu, "<path>");
}

function clip(text, max = EXAMPLE_MAX_CHARS) {
  const flat = redactPaths(String(text ?? "").replace(/\s+/gu, " ").trim());
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 给一条用户消息分类；不是介入就返回 null。
 * @returns {{ role: string, example: string } | null}
 */
export function classifyIntervention(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  for (const p of PATTERNS) {
    if (p.test(t)) return { role: p.role, example: clip(t) };
  }
  return null;
}

/** 解析 JSONL（坏行跳过并计数，不因为一行坏掉整份报告作废） */
export function parseSessionLines(lines) {
  const messages = [];
  let broken = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === "object") messages.push(record);
      else broken += 1;
    } catch {
      broken += 1;
    }
  }
  return { messages, broken };
}

/** 开场白的归一化键：取第一行前 80 字，去掉标点与空白差异 */
function openingKey(text) {
  const first = String(text ?? "").split(/\r?\n/u).find((l) => l.trim()) ?? "";
  return first
    .replace(/[\s，。！？、,.!?；;：:]/gu, "")
    .slice(0, 80)
    .toLowerCase();
}

/**
 * 分析若干会话。
 * @param {Array<{ id: string, file?: string, messages: any[] }>} sessions
 * @param {{ since?: number }} [options]
 */
export function analyzeSessions(sessions, options = {}) {
  const since = options.since ?? 0;
  const perRole = Object.fromEntries(ROLES.map((r) => [r, 0]));
  const perSession = [];
  const openings = new Map();
  let userMessages = 0;

  for (const session of sessions) {
    const id = String(session.id ?? "");
    if (id.startsWith(INTERNAL_SESSION_PREFIX)) continue;

    const users = (session.messages ?? []).filter(
      (m) => m?.role === "user" && typeof m?.timestamp === "number" && m.timestamp >= since && m?.content,
    );
    if (users.length === 0) continue;
    userMessages += users.length;

    const hits = [];
    const seen = new Set();
    for (const message of users) {
      const content = typeof message.content === "string" ? message.content : "";
      if (!isHumanMessage(content)) continue; // 平台/工具注入的提醒不是"人的介入"
      const dedupeKey = content.trim();
      if (seen.has(dedupeKey)) continue; // 同一条消息的重复副本只算一次
      seen.add(dedupeKey);
      const hit = classifyIntervention(content);
      if (hit) hits.push({ ...hit, timestamp: message.timestamp });
    }

    for (const hit of hits) perRole[hit.role] += 1;

    /**
     * 「开场白」不能取**字面上的第一条**用户消息。
     *
     * 真机与夹具都撞到过：会话被续跑时第一条常是「继续」「可以」这类应答，
     * 于是同一类任务的两次会话永远配不上对（夹具里就是这么漏掉 trigger 的）。
     * 取第一条**实质内容**（不是批准/重试）的消息；全是应答时退回第一条。
     */
    const humanMessages = users.filter((m) => typeof m.content === "string" && isHumanMessage(m.content));
    const first =
      humanMessages.find((m) => {
        const role = classifyIntervention(m.content)?.role;
        return role !== "approve" && role !== "retry";
      }) ?? humanMessages[0];
    if (first) {
      const key = openingKey(first.content);
      if (key.length >= 4) {
        const entry = openings.get(key) ?? { key, sessions: [], example: clip(first.content) };
        entry.sessions.push(id);
        openings.set(key, entry);
      }
    }

    if (hits.length > 0) {
      perSession.push({ id, userMessages: users.length, hits });
    }
  }

  const repeats = [...openings.values()]
    .filter((o) => new Set(o.sessions).size >= 2)
    .sort((a, b) => b.sessions.length - a.sessions.length)
    .slice(0, 10)
    .map((o) => ({ ...o, sessions: [...new Set(o.sessions)] }));

  const total = Object.values(perRole).reduce((n, v) => n + v, 0);
  return {
    sessions: sessions.length,
    userMessages,
    totalInterventions: total,
    perRole,
    perSession: perSession.sort((a, b) => b.hits.length - a.hits.length),
    repeatedOpenings: repeats,
  };
}

/** 渲染成人读的 markdown（不写文件；写入由调用方显式做） */
export function renderReport(report, meta = {}) {
  const lines = [];
  lines.push("# 人工介入复盘（只读报告）");
  lines.push("");
  lines.push(
    `> 扫描 ${report.sessions} 个会话 / ${report.userMessages} 条用户消息；` +
      `识别到 ${report.totalInterventions} 次人工介入。`,
  );
  if (meta.dir) lines.push(`> 数据目录：${redactPaths(meta.dir)}`);
  lines.push(">");
  lines.push("> **这是启发式候选，不是结论。** 每条都带原文片段，请自己复核；");
  lines.push("> 没有原文片段的计数一律不可信，不要据此改规则。");
  lines.push("");

  lines.push("## 按角色统计");
  lines.push("");
  lines.push("| 角色 | 次数 | 含义 |");
  lines.push("| --- | ---: | --- |");
  const meaning = {
    retry: "卡住/失败后让 agent 再来一次",
    judge: "判断输出好不好",
    approve: "给 agent 等的那个「可以」",
    carry: "把 agent 本该自己找到的上下文递过去",
    trigger: "手动开同一类任务（见下节）",
    "stand-in": "做了 agent 本可以做的事",
  };
  for (const role of ROLES) {
    lines.push(`| ${role} | ${report.perRole[role]} | ${meaning[role] ?? ""} |`);
  }
  lines.push("");

  if (report.repeatedOpenings.length > 0) {
    lines.push("## 重复的开场白（trigger 候选）");
    lines.push("");
    for (const o of report.repeatedOpenings) {
      lines.push(`- ${o.sessions.length} 个会话用了同一个开场：「${o.example}」`);
    }
    lines.push("");
  }

  if (report.perSession.length > 0) {
    lines.push("## 介入最多的会话");
    lines.push("");
    for (const s of report.perSession.slice(0, 10)) {
      const counts = Object.entries(
        s.hits.reduce((acc, h) => ({ ...acc, [h.role]: (acc[h.role] ?? 0) + 1 }), {}),
      )
        .map(([role, n]) => `${role}×${n}`)
        .join(" / ");
      lines.push(`### ${s.id}（${s.userMessages} 条用户消息，${s.hits.length} 次介入）`);
      lines.push("");
      lines.push(`- ${counts}`);
      for (const hit of s.hits.slice(0, 5)) {
        lines.push(`- **${hit.role}**：${hit.example}`);
      }
      lines.push("");
    }
  } else {
    lines.push("## 介入最多的会话");
    lines.push("");
    lines.push("（没有识别到介入 —— 要么用得顺，要么启发式没覆盖到你的说法。）");
    lines.push("");
  }

  lines.push("## 下一步（人拍板，工具不代劳）");
  lines.push("");
  lines.push("对反复出现的那一条，按这个顺序找最便宜的出口：");
  lines.push("");
  lines.push("1. **删**：让这次介入变得没必要的陈旧规则/设置；");
  lines.push("2. **改现有产物**：AGENTS.md / 项目技能 / 定时任务提示词；");
  lines.push("3. **机械化**：能变成脚本、lint、自检的，就不要留给人判断；");
  lines.push("4. **新技能**：同类任务在 3 个以上会话里出现、且现成产物都放不下；");
  lines.push("5. **自动触发**：定时任务或钩子；");
  lines.push("6. **建议**：原因在人的工作方式上时，直说。");
  lines.push("");
  return lines.join("\n");
}

/** 默认数据根：%APPDATA%/com.codem.app/sessions（Windows）或 ~/.codem/sessions */
export function defaultSessionsDir() {
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, "com.codem.app", "sessions");
  return path.join(os.homedir(), ".codem", "sessions");
}

/** 读取目录下的会话文件（只读；跳过内部会话） */
export function loadSessions(dir, options = {}) {
  if (!fs.existsSync(dir)) return { sessions: [], skipped: 0 };
  const since = options.since ?? 0;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .filter((f) => f.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);

  const sessions = [];
  let skipped = 0;
  for (const file of files) {
    const full = path.join(dir, file.name);
    try {
      const text = fs.readFileSync(full, "utf8");
      const { messages, broken } = parseSessionLines(text.split(/\r?\n/u));
      if (broken > 0) skipped += 1;
      const id = file.name.replace(/\.jsonl$/u, "");
      sessions.push({ id, file: full, messages });
    } catch {
      skipped += 1;
    }
  }
  return { sessions, skipped };
}

function main(argv) {
  const arg = (name, fallback = undefined) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const dir = arg("--dir", defaultSessionsDir());
  const sinceDate = arg("--since");
  const since = sinceDate ? Date.parse(`${sinceDate}T00:00:00`) : 0;
  if (sinceDate && Number.isNaN(since)) {
    console.error(`error: --since 需要 YYYY-MM-DD，收到 ${sinceDate}`);
    process.exit(1);
  }
  const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
  const out = arg("--out");

  const { sessions, skipped } = loadSessions(dir, { since, limit });
  const report = analyzeSessions(sessions, { since });
  const markdown = renderReport(report, { dir });

  if (argv.includes("--json")) console.log(JSON.stringify({ report, skipped }, null, 2));
  else console.log(markdown);

  if (out) {
    fs.writeFileSync(out, markdown, "utf8");
    console.log(`\n（已写入 ${redactPaths(out)}）`);
  }
  if (skipped > 0) console.warn(`warn: ${skipped} 个会话文件有坏行或读取失败（已跳过坏行）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
