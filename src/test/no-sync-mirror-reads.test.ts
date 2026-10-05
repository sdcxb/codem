/**
 * 第 144 波：**结构性边界 —— 数据层以外，不许使用"同步整表/整会话读"** ✓。
 *
 * ## 为什么需要这道门（用户的原话）
 *
 * > 我感觉你还是治标没治本，你这次【不搬数据 = 这 262 处改成按需异步查询】，
 * > 未来遇到其他情况，镜像遇到问题呢？
 *
 * 对 ✓。**逐个搬迁症状本身也是治标** ✗：模型没被禁掉 ✓，
 * 将来还会有人（包括我 ✗）为了让某处代码"同步拿到数据"而再加一个镜像 ✗。
 *
 * 真正治本要有**结构性的边界** ✓ —— 与本仓库既有的
 * 「`src/core/llm/**` 不许 import `node:fs`」（`no-node-fs-in-llm.test.ts` ✓）同一套路 ✓：
 * 不是靠"记得别这么写"✗，而是靠**判据让它写不成** ✓。
 *
 * ## 这道门钉什么
 *
 * `src/**` 里（**除数据层 `src/core/storage/**` 与测试** ✓）不许出现
 * **同步整表/整会话读**：
 * `readAll(`、`listMessages(`、`domainReadMany(`、`domainReadOne(` ✓ ——
 * 它们正是"必须有镜像驻留才能工作"的那些调用 ✗。
 *
 * 规则是**冻结基线 + 不许增长** ✓：
 * - **新文件**出现这些调用 ⇒ 红 ✓（这条拦住的正是"将来又加一个镜像" ✗）；
 * - 已存在的文件**数量增加** ⇒ 红 ✓；
 * - 数量减少 ⇒ ✅ **必须同步更新基线**（基线只能变小 ✓）——
 *   于是这场迁移是**单调的** ✓，不会来回反复 ✗。
 *
 * ## 终局（⚠️ 第 145 波按用户追问更正过一次 ✗→✓）
 *
 * **我们不禁用同步读** ✗ —— 禁的是**无界的**同步读 ✗。同步读的正当形式是 **领域投影** ✓：
 * DSH 的 `storage-domain` README 原文是「**内存具有最终决定权；介质是持久投影。
 * 读取同步取自经过校验的内存状态**」✓，写路径固定为
 * 「先到达后端持久状态，**再变更内存**，然后发出 `domain/changed`」✓
 * ⇒ 消费方拿到的是「**同步读取** + 发出变更事件的写入」✓。
 *
 * 因此本基线的两类条目**终局不同** ✓：
 *
 * | 类别 | 例子 | 终局 |
 * |---|---|---|
 * | **整会话读**（无界 ✗） | `readAll(` / `listMessages(` | **必须归 0** ✓（消息/事件镜像删掉 ✗→✓） |
 * | **领域读**（有界 ✓） | `domainReadMany(` / `domainReadOne(` | **本身不违规** ✓ —— 只要读的是**已声明的有界领域**（projects/settings/notes/squads ✓）。下一版门要按**表名白名单**判 ✓，而不是按函数名一刀切 ✗ |
 *
 * 换句话说：把"用户浏览史"这种无界对象搬进渲染进程才是错的 ✗；
 * 把"项目列表"这种小域投影进内存**就是对的** ✓。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **数据层实现文件**（唯一允许直接使用这些接口的地方 ✓）。
 *
 * ## ⚠️ 第 147 波：这里原来是"排除整个 `src/core/storage/**`" ✗ —— 那是个**漏洞** ✗
 *
 * 因为**消费方也住在那个目录里** ✓：`maintenance.ts` 的
 * `domainReadMany(TELEMETRY_TABLE, …)`（`TELEMETRY_TABLE = "telemetry_events"` ✗）
 * 就是这样**逃过了这道门** ✓ —— 而它读的正是无界表 ✗。
 * 改成显式白名单之后，量出的面从 31 文件/119 处升到 **43 文件/158 处** ✓
 * （数字变大是**修正** ✓，不是退步 ✓：原来的少算是排除过宽造成的 ✗）。
 */
const DATA_LAYER_FILES = new Set([
  "src/core/storage/domain-store.ts",
  "src/core/storage/rust-port.ts",
  "src/core/storage/port.ts",
  "src/core/storage/event-log.ts",
  "src/core/storage/message.ts",
  "src/core/storage/event-projection.ts",
]);

/**
 * **冻结基线**（第 144 波的真机实测值 ✓）：文件 → 该文件里这类调用的出现次数。
 *
 * 只能变小 ✓：迁移一处就把它减一 ✓；减到 0 就把这一行删掉 ✓。
 */
const BASELINE: Record<string, number> = {
  "src/core/knowledge/storage.ts": 30,
  "src/core/session/delegation-storage.ts": 8,
  "src/core/squad/squad-storage.ts": 8,
  "src/core/storage/session.ts": 7,
  "src/core/inbox/inbox-storage.ts": 6,
  "src/core/issue/issue-storage.ts": 6,
  "src/store.ts": 5,
  "src/core/knowledge/flashcard-store.ts": 4,
  "src/core/llm/index.ts": 4,
  "src/core/storage/account.ts": 4,
  "src/core/storage/project.ts": 4,
  "src/core/storage/prompt-draft.ts": 4,
  "src/core/goal/goal.ts": 3,
  "src/core/llm/agentic-loop.ts": 3,
  "src/core/llm/feedback.ts": 3,
  "src/core/llm/runtime-invariants.ts": 3,
  "src/core/llm/tools/show-todo.ts": 3,
  "src/core/storage/agent-profile-storage.ts": 3,
  "src/core/storage/file-change-storage.ts": 3,
  "src/App.tsx": 2,
  "src/core/llm/time-context.ts": 2,
  "src/core/phone-link/phone-link.ts": 2,
  "src/core/provider/session-persistence-sqlite-provider.ts": 2,
  "src/core/agent/preset-discovery.ts": 1,
  "src/core/llm/compaction-control.ts": 1,
  "src/core/llm/postmortem.ts": 1,
  "src/core/llm/tools/read-attachment.ts": 1,
  "src/core/llm/tools/session-search.ts": 1,
  "src/core/provider/ui-trajectory-provider.ts": 1,
  "src/core/session/tools.ts": 1,
  "src/core/storage/session-log-bridge.ts": 1,
  "src/core/storage/settings.ts": 1,
  "src/core/storage/sync-engine.ts": 1,
  "src/core/storage/v2-session.ts": 1,
  "src/core/store.ts": 1,
  "src/core/telemetry/telemetry.ts": 1,
  "src/test/r3-snapshot-tests.ts": 1,
};

/** 这些调用 = "必须有镜像驻留才能工作" ✗ */
const FORBIDDEN = /readAll\(|listMessages\(|domainReadMany\(|domainReadOne\(/;

/**
 * **剥掉注释再扫**（第 150 波 ✓）。
 *
 * 为什么必须剥 ✗：注释里解释"这里原来用 `domainReadMany(...)` ✗"也会被算成依赖 ✗ ——
 * 实测就有一次：`maintenance.ts` 被记进"无界对象越界清单"，靠的**正是我刚写下的那句注释** ✗。
 * 反过来说：判断"代码依赖什么"必须**只看代码** ✓。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * **无界对象**（第 146 波）：这些表**不许**经同步的领域读接口访问 ✗ ✓。
 *
 * 判据来自"它们会随用户使用无限增长" ✓：
 * 会话消息、会话事件、工具调用、遥测、审计、跨轮文件变更、笔记块（每行带 embedding ✓）。
 * 读它们必须走**按需查询**（`port.queryEvents/queryMessages` ✓）或**变更订阅** ✓ ——
 * 也就是 DSH 的模型 ✓（`session-query.zh.md`：「一次精确读取……而不是持续保留的订阅」✓）。
 *
 * 反过来 ✓：**不在这个集合里的表默认允许** ✓ —— 它们是"已声明的有界领域" ✓
 * （projects / goals / inbox / issues / squads / flashcards / settings ✓），
 * 把它们投影进内存**就是对的** ✓（DSH `storage-domain`：「读取同步取自经过校验的内存状态」✓）。
 */
const UNBOUNDED_TABLES = new Set([
  "messages",
  "session_events",
  "tool_calls",
  "telemetry_events",
  "storage_audit",
  "turn_file_changes",
  "notebook_chunks",
]);

/**
 * 解析同文件里的常量（`const TABLE = "goals"` ✓、`const A = B` ✓ 递归一层层跟 ✓）。
 * 解析不出来就返回 null ⇒ 记进 `UNRESOLVED_BASELINE` ✓（它也只许变小 ✓）。
 */
function resolveConst(text: string, name: string, depth = 0): string | null {
  if (depth > 4) return null;
  /**
   * ⚠️ 第 148 波：**只解析纯标识符** ✓ ——
   * 实参里可能是表达式（`foo()` / `(x as any).y` ✗），把它拼进正则会让分组错位 ✗
   * 甚至抛 TypeError ✓（实测就是这么崩的 ✗）。表达式一律算"解析不出来" ✓。
   */
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const m = text.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`));
  if (!m) return null;
  const rhs = m[1].trim();
  const lit = rhs.match(/^["'`]([A-Za-z0-9_]+)["'`]$/);
  if (lit) return lit[1];
  const next = rhs.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  if (next) return resolveConst(text, next[1], depth + 1);
  return null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 统计每个文件里这类调用的次数（不含数据层与测试 ✓） */
function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk("src")) {
    const rel = relative(process.cwd(), file).replace(/\\/g, "/");
    if (DATA_LAYER_FILES.has(rel)) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    const n = (text.match(new RegExp(FORBIDDEN, "g")) ?? []).length;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

describe("第 144 波：数据层以外不许使用同步整表/整会话读（结构性边界）", () => {
  it("SYNC-1: **新文件**不许出现这类调用（这条拦住'将来又加一个镜像' ✗）", () => {
    const now = currentCounts();
    const newcomers = Object.keys(now).filter((f) => BASELINE[f] === undefined);
    expect(
      newcomers,
      `这些文件新增了对"同步整表/整会话读"的依赖 ✗ —— 它们必须有镜像驻留才能工作 ✓。\n` +
        `请改成按需查询（\`port.queryEvents/queryMessages\` 一类 ✓）或变更订阅 ✓，\n` +
        `而不是把它们加进基线 ✗（基线只能变小 ✓）：\n  ${newcomers.join("\n  ")}`,
    ).toEqual([]);
  });

  it("SYNC-2: 基线里的文件**不许增长**（迁移必须单调 ✓，不许来回反复 ✗）", () => {
    const now = currentCounts();
    const grown: string[] = [];
    for (const [file, base] of Object.entries(BASELINE)) {
      const n = now[file] ?? 0;
      if (n > base) grown.push(`${file}: ${base} → ${n}`);
    }
    expect(grown, `这些文件的依赖变多了 ✗（基线只能变小 ✓）：\n  ${grown.join("\n  ")}`).toEqual([]);
  });

  it("SYNC-3: 基线**必须与现状一致**（迁移完成一处就要如实收紧 ✓，免得基线变成一句空话 ✗）", () => {
    const now = currentCounts();
    const stale: string[] = [];
    for (const [file, base] of Object.entries(BASELINE)) {
      const n = now[file] ?? 0;
      if (n < base) stale.push(`${file}: 基线 ${base} → 现状 ${n}（请把基线改成 ${n}${n === 0 ? " 或删掉这一行" : ""}）`);
    }
    expect(
      stale,
      `迁移已经推进了，但基线还停在旧数字 ✗ —— 请如实收紧（这保证基线反映真实的剩余面 ✓）：\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("SYNC-5: **无界对象**不许经同步领域读接口访问（这一条按表名判 ✓，不是按函数名一刀切 ✗）", () => {
    /**
     * 第 146 波升级 ✓：`domainReadMany/One` 读**小域**（projects/goals/… ✓）是正当的领域投影 ✓，
     * 读**无界对象**（messages/session_events/telemetry_events/… ✗）才是错的 ✗。
     * 表名多半是文件里的常量（`const TABLE = "goals"` ✓）⇒ 这里解析同文件常量 ✓。
     */
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (DATA_LAYER_FILES.has(rel)) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/domainRead(?:Many|One)\b[^(]*\(\s*([^,)\n]+)/g)) {
        const raw = m[1].trim();
        const lit = raw.match(/^["'`]([A-Za-z0-9_]+)["'`]$/);
        const table = lit ? lit[1] : resolveConst(text, raw.replace(/!$/, ""));
        if (table && UNBOUNDED_TABLES.has(table)) {
          offenders.push(`${rel}: ${raw} → 表 ${table} ✗`);
        }
      }
    }
    /**
     * **迁移中的已知越界**（第 146 波实测 ✓）：只许变小 ✓，不许新增 ✓。
     *
     * - `knowledge/storage.ts` 的 `T_CHUNKS`（= `notebook_chunks` ✓）：块镜像本来就是"超上限就拒"的设计 ✓，
     *   该域迟早要搬到按需查询 ✓；
     * - `telemetry/telemetry.ts` 的 `TABLE`（= `telemetry_events` ✓）：正是 5000 行那条报错的来源 ✓，
     *   它需要一个自己的按需查询（`queryEvents` 是会话事件的 ✓，不含遥测 ✓）。
     */
    expect(
      offenders.sort(),
      `已知越界清单必须**恰好**等于现状 ✓ —— 少了就请收紧这份清单 ✓，多了说明引入了新的无界同步读 ✗：\n` +
        `  现状：\n    ${offenders.join("\n    ")}`,
    ).toEqual([
      "src/core/knowledge/storage.ts: T_CHUNKS → 表 notebook_chunks ✗",
      "src/core/knowledge/storage.ts: T_CHUNKS → 表 notebook_chunks ✗",
      "src/core/storage/file-change-storage.ts: TABLE → 表 turn_file_changes ✗",
      "src/core/storage/file-change-storage.ts: TABLE → 表 turn_file_changes ✗",
      "src/core/storage/file-change-storage.ts: TABLE → 表 turn_file_changes ✗",
      "src/core/telemetry/telemetry.ts: TABLE → 表 telemetry_events ✗",
    ].sort());
  });

  it("SYNC-4: 基线总量有记录（终局目标 = 0 ✓，这个数字必须只降不升 ✓）", () => {
    const total = Object.values(BASELINE).reduce((a, b) => a + b, 0);
    expect(total, `当前剩余 ${total} 处（第 144 波按**与判据同一套扫描**测得的真实面 ✓）`).toBeLessThanOrEqual(133);
  });
});


