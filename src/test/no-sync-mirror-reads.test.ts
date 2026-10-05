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
 * ## 终局（写在这里，免得后来人以为这就是终点）
 *
 * 1. 渲染层不再"整表/整会话读" ✓，改成**按视图取数** ✓（`port.queryEvents/queryMessages` 这类 ✓）
 *    或**变更订阅** ✓ —— 也就是 DSH 的模型 ✓
 *    （`session-query.zh.md`：「一次精确读取……**而不是持续保留的订阅**」✓）；
 * 2. 消息镜像与事件镜像**删掉** ✗→✓（基线归零 ✓）；
 * 3. 只有**小域**（projects / settings 等 ✓，本来就小且必须同步 ✓）保留驻留 ✓。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** 数据层：这里**允许**同步整表读 ✓（它就是镜像/端口的实现所在 ✓）。 */
const DATA_LAYER = join("src", "core", "storage");

/**
 * **冻结基线**（第 144 波的真机实测值 ✓）：文件 → 该文件里这类调用的出现次数。
 *
 * 只能变小 ✓：迁移一处就把它减一 ✓；减到 0 就把这一行删掉 ✓。
 */
const BASELINE: Record<string, number> = {
  "src/core/knowledge/storage.ts": 30,
  "src/core/session/delegation-storage.ts": 8,
  "src/core/squad/squad-storage.ts": 8,
  "src/core/inbox/inbox-storage.ts": 6,
  "src/core/issue/issue-storage.ts": 6,
  "src/core/llm/runtime-invariants.ts": 6,
  "src/store.ts": 6,
  "src/core/knowledge/flashcard-store.ts": 4,
  "src/core/llm/index.ts": 4,
  "src/App.tsx": 3,
  "src/core/goal/goal.ts": 3,
  "src/core/llm/agentic-loop.ts": 3,
  "src/core/llm/feedback.ts": 3,
  "src/core/llm/time-context.ts": 3,
  "src/core/llm/tools/show-todo.ts": 3,
  "src/core/phone-link/phone-link.ts": 3,
  "src/core/llm/compaction-budget.ts": 2,
  "src/core/llm/tools/session-search.ts": 2,
  "src/core/project/files.ts": 2,
  "src/core/provider/session-persistence-sqlite-provider.ts": 2,
  "src/core/provider/ui-trajectory-provider.ts": 2,
  "src/components/ContextMonitor.tsx": 1,
  "src/core/agent/preset-discovery.ts": 1,
  "src/core/llm/compaction-control.ts": 1,
  "src/core/llm/postmortem.ts": 1,
  "src/core/llm/tools/read-attachment.ts": 1,
  "src/core/session/fork-index.ts": 1,
  "src/core/session/tools.ts": 1,
  "src/core/store.ts": 1,
  "src/core/telemetry/telemetry.ts": 1,
  "src/test/r3-snapshot-tests.ts": 1,
};

/** 这些调用 = "必须有镜像驻留才能工作" ✗ */
const FORBIDDEN = /readAll\(|listMessages\(|domainReadMany\(|domainReadOne\(/;

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
    if (rel.startsWith(DATA_LAYER.replace(/\\/g, "/"))) continue;
    const text = readFileSync(file, "utf8");
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

  it("SYNC-4: 基线总量有记录（终局目标 = 0 ✓，这个数字必须只降不升 ✓）", () => {
    const total = Object.values(BASELINE).reduce((a, b) => a + b, 0);
    expect(total, `当前剩余 ${total} 处（第 144 波按**与判据同一套扫描**测得的真实面 ✓）`).toBeLessThanOrEqual(119);
  });
});
