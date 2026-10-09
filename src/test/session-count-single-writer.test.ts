/**
 * `SESSION-COUNT-SINGLE-WRITER`：`sessions.message_count` 只许有**一个**写入者（引擎）。
 *
 * ## 被守的形态（第 191 波"全仓搜同类"的第四个簇）
 *
 * 修 O-42 时（"写消息 → 读计数同步可见"）全仓搜同族写法，找到 **4 处**「渲染侧自己算
 * `messageCount + 1` 再写回会话行」：
 *
 * | 位置 | 形态 |
 * | --- | --- |
 * | `src/App.tsx` `safeAddMessage` | `updateSession(id, { messageCount: session.messageCount + 1 })` |
 * | `src/components/NotebookWorkspace.tsx` | 同上（`updatedCount`） |
 * | `src/core/wechat-bridge/wechat-bridge.ts` | `{ messageCount: row.messageCount + 1 }` |
 * | `src/core/phone-link/phone-link.ts` | `{ messageCount: (row.messageCount \|\| 0) + 1 }` |
 *
 * ## 为什么这是缺陷（不是"顺手更新一下"）
 *
 * 那一列在引擎侧是**由消息写入自动维护**的（`repo.rs::bump_session_message_count`，在
 * `messages.upsert_index` 的同一事务里）。渲染侧再写一个"自己读到的值 + 1"就是**第二个写入者**：
 * 引擎随后 bump 一次 ⇒ 该会话从此**多算 1 条**（直到 12 小时的对账按索引真值重算才自愈）。
 * 更糟的是它**看起来是对的**（数字确实涨了），所以没有任何东西会红 —— 这正是本仓
 * 「同一事实两套口径」的典型受害形态。
 *
 * ## 判据
 *
 * - `SCW-1`（解析式对账 + 例外表不许过期）：`src/**`（除 `src/test/**`）里凡是
 *   `updateSession(...)` 调用中显式给 `messageCount` 的，必须登记在例外表里并写明
 *   **为什么它是"有据的真值"**（索引真值重算 / 复制条数）；
 * - `SCW-2`：上面那 4 处**不许**再出现（改回渲染侧 +1 ⇒ 判据红，变异见
 *   `tools/mutate/specs/session-count-191.json`）；
 * - `SCW-3`（防恒真）：谓词对历史形态必须命中、对合法形态（只写 `lastMessageAt`）必须不命中。
 *
 * ⚠️ 如实登记口径：例外表只接受「写的是**有据的真值**」（消息索引真值 / 分叉时真实复制的条数）；
 * 「读到的值 + 1」永远不是有据的真值，所以不受例外保护。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

interface CountWriteException {
  file: string;
  occurrences: number;
  reason: string;
}

/**
 * **例外表**：写 `messageCount` 是**有据的真值**（不是"读到的值 + 1"）。
 * 每条都要真的命中（次数对不上 ⇒ 红），所以它不会悄悄过期。
 */
const EXCEPTIONS: CountWriteException[] = [
  {
    file: "src/core/store.ts",
    occurrences: 1,
    reason:
      "forkSession：写的是**实际复制的条数**（`copiedCount`），紧接着调 `reconcileSessionMessageCountById` 按索引真值复核（第 47 轮线协议审计 P2-D11）——有据",
  },
  {
    file: "src/core/storage/message.ts",
    occurrences: 1,
    reason: "reconcileSessionMessageCountById：写的是**按索引真值重算**出来的总数（P2-4 的闭环动作）——有据",
  },
  {
    file: "src/core/storage/maintenance.ts",
    occurrences: 1,
    reason: "启动维护的对账：按索引真值重算 `sessions.message_count`（第 44 轮）——有据",
  },
];

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1} `);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name === "test" && path.basename(dir) === "src") continue;
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(abs);
  }
  return out;
}

/**
 * 判定谓词（纯函数）：这一行是不是"给 `updateSession` 显式传 `messageCount`"。
 * 用**逐行**判定（调用常跨行，所以看的是"调用名 + 参数里出现 messageCount"这一整段文本）。
 */
export function looksLikeRendererCountWrite(code: string): boolean {
  // `updateSession(` 之后到匹配的右括号之间的文本里出现 `messageCount:`
  const re = /updateSession\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    const args = code.slice(m.index + m[0].length, i);
    if (/\bmessageCount\s*:/.test(args)) return true;
  }
  return false;
}

describe("SESSION-COUNT-SINGLE-WRITER：会话消息计数只许引擎写（第 191 波同簇收口）", () => {
  it("SCW-1/2: 只有例外表里的「有据真值」可以写 messageCount，4 处渲染侧 +1 必须消失", () => {
    const offenders: string[] = [];
    const tally = new Map<string, number>();
    for (const full of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (rel.startsWith("src/test/")) continue;
      const code = stripComments(readFileSync(full, "utf8"));
      if (looksLikeRendererCountWrite(code)) {
        tally.set(rel, (tally.get(rel) ?? 0) + 1);
        if (!EXCEPTIONS.some((e) => e.file === rel)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `这些文件给 updateSession 传了 messageCount（引擎是那一列的唯一写入者；` +
        `渲染侧"读到的值 + 1"会让会话长期多算 1 条）：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);

    // 例外表不许过期（次数也要对得上）
    for (const e of EXCEPTIONS) {
      expect(tally.get(e.file) ?? 0, `例外表里的 ${e.file} 不再命中（条目过期）或次数变了`).toBe(e.occurrences);
      expect(e.reason.length, `${e.file} 的例外理由太短`).toBeGreaterThan(10);
    }
    expect(new Set(EXCEPTIONS.map((e) => e.file)).size).toBe(EXCEPTIONS.length);

    // 那 4 处（历史形态）必须已经不再出现
    for (const rel of [
      "src/App.tsx",
      "src/components/NotebookWorkspace.tsx",
      "src/core/wechat-bridge/wechat-bridge.ts",
      "src/core/phone-link/phone-link.ts",
    ]) {
      const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
      expect(looksLikeRendererCountWrite(code), `${rel} 不许再给 updateSession 传 messageCount`).toBe(false);
    }
  });

  it("SCW-3 防恒真: 谓词对历史形态必须命中、对合法形态必须不命中", () => {
    const historical = [
      "useProjectStore.getState().updateSession(session.id, { messageCount: session.messageCount + 1, lastMessageAt: Date.now() });",
      "SessionStorage.updateSession(sessionId, {\n  lastMessageAt: Date.now(),\n  model: row.model,\n  messageCount: row.messageCount + 1,\n});",
      "SessionStorage.updateSession(session.id, { messageCount: updatedCount, lastMessageAt: Date.now() });",
    ];
    for (const s of historical) expect(looksLikeRendererCountWrite(s), `历史形态必须命中：${s.slice(0, 50)}`).toBe(true);

    const legitimate = [
      "SessionStorage.updateSession(session.id, { lastMessageAt: Date.now() });",
      "SessionStorage.updateSession(sessionId, { title: t, pinned: true });",
      // 对账写"索引真值"是允许的（真值来自 count_by_session，不是"读到的值 + 1"）
      "SessionStorage.updateSession(id, { messageCount: total });",
    ];
    expect(looksLikeRendererCountWrite(legitimate[0]), "只写 lastMessageAt 不许命中").toBe(false);
    expect(looksLikeRendererCountWrite(legitimate[1]), "只写标题/置顶不许命中").toBe(false);
    // 第三条命中（它确实写了 messageCount）—— 而它靠**例外表**而不是谓词放过，
    // 这正是"谓词只判形状、例外表判有据"的分工。
    expect(looksLikeRendererCountWrite(legitimate[2]), "写 messageCount 的形状必须命中").toBe(true);
  });
});
