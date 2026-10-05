/**
 * 第 133 波：**"同族判据"不该被"第一次编辑"一次性用掉**。
 *
 * ## 证据（真机日志，repo-02 在 1.16.247 上的一次运行）
 *
 * ```
 * [agent-loop] symbol siblings: null | edited= src/core/llm/index.ts
 * ```
 *
 * 机制**触发了** ✓，但那个文件里的符号没有任何判据提到 ⇒ 返回 null ✗；
 * 而它当初是"每回合只允许触发一次" ✗ ⇒ **第一次编辑就把唯一机会用掉了** ✗：
 * 之后哪怕它去改 `tools.ts`（那里的 `applyToolResultStatus` 正是 `dsh-d9` 的符号 ✓）也不会再提示 ✗。
 * 这正好解释 repo-02 的**轮间波动**：先改 `tools.ts` ⇒ 拿到提示 ⇒ 两轮都过 ✓；
 * 先改 `index.ts` ⇒ 空手 ⇒ 猜着改 ⇒ 失败 ✗。
 *
 * ## 改法
 *
 * 改成"**每个被编辑的文件最多提示一次**、每回合总数上限 4" ✓ —— 仍然有界 ✓，但不会因
 * "第一次编辑恰好没有同族判据"而放弃整回合 ✓。
 *
 * ## 计数口径（这一条我绕了三次，写清楚）
 *
 * 1. 在整个转录里数 `[同族判据]` ✗ —— 提示进了历史，会被之后**每一次请求**重发 ✓；
 * 2. 只看"最后一次请求的 messages" ✗ —— 收尾轮口径不稳 ✓（实测 0 条 ✓）；
 * 3. 按"消息里含 result 字样"过滤 ✗ —— 助手消息里也有那个词 ✓。
 * ⇒ **正确做法**：打开 `agent-loop` 的 debugLog 开关、监听 `console.log`，
 *    数 `symbol siblings:` 那几行 ✓（**一行 = 一次产出** ✓）。
 *
 * 变异自证：把上限改回"每回合一次" ⇒ SSB-5 红；去掉按文件去重 ⇒ SSB-6 红。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { resetDebugCache } from "../core/debug";

vi.mock("../core/file-api", () => {
  const { readdirSync, readFileSync } = require("node:fs");
  const { join: j } = require("node:path");
  return {
    listDirectory: async (dir: string) =>
      readdirSync(dir, { withFileTypes: true }).map((e: any) => ({
        name: e.name,
        path: j(dir, e.name),
        isDirectory: e.isDirectory(),
      })),
    readFile: async (path: string) => readFileSync(path, "utf8"),
    readTextWindow: async (path: string, _o = 0, maxBytes?: number) => {
      const text = readFileSync(path, "utf8");
      return { text: maxBytes ? text.slice(0, maxBytes) : text, totalLines: text.split("\n").length };
    },
    grepSearch: async (pattern: string, root: string) => {
      const out: string[] = [];
      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 8) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          const full = j(dir, e.name);
          if (e.isDirectory()) {
            walk(full, rel, depth + 1);
            continue;
          }
          if (!/\.(ts|tsx|js|jsx)$/.test(e.name)) continue;
          if (readFileSync(full, "utf8").includes(pattern)) out.push(`${rel}:1: ${pattern}`);
        }
      };
      walk(root, "", 0);
      return out;
    },
  };
});

class ScriptedProvider {
  id = "ssb-provider";
  name = "SSB Mock";
  config: any = { apiKey: "sk-test" };
  requests: any[] = [];
  private queue: any[][] = [];
  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.queue.shift();
    if (!script) throw new Error("脚本耗尽");
    for (const item of script) yield item;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
}

function editIteration(id: string, path: string): any[] {
  return [
    { type: "tool_use_start", id, name: "edit" },
    { type: "tool_use_delta", id, input: JSON.stringify({ path, old_string: "a", new_string: "b" }) },
    { type: "tool_use_end", id, input: { path, old_string: "a", new_string: "b" } },
    { type: "end", finishReason: "tool_use" },
  ];
}

const finalIteration = (t: string) => [
  { type: "text_delta", text: t },
  { type: "end", finishReason: "stop" },
];

function registry() {
  const reg = createDefaultToolRegistry();
  reg.register({
    id: "edit",
    description: "假 edit",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute(args: any) {
      return { title: "edit", output: `Successfully edited ${String(args?.path ?? "")}` };
    },
  } as any);
  return reg;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "codem-ssb-"));
  mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
  mkdirSync(join(root, "src", "test"), { recursive: true });
  // ① 符号不被任何判据提到的文件（模拟 index.ts 那种情况）
  writeFileSync(join(root, "src", "core", "llm", "index.ts"), "export function someUnrelatedHelper() {}\n");
  // ② 符号被 dsh-d9 提到的文件（模拟 tools.ts）
  writeFileSync(join(root, "src", "core", "llm", "tools.ts"), "export function applyToolResultStatus() {}\n");
  writeFileSync(join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"), "// applyToolResultStatus 的判据\n");
  return root;
}

async function runEdits(session: string, cwd: string, paths: string[]): Promise<{ produced: number; events: any[] }> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  (globalThis as any).__CODEM_DEBUG__ = "agent-loop";
  resetDebugCache();
  const provider = new ScriptedProvider();
  provider.setScript([...paths.map((p, i) => editIteration(`e${i + 1}`, p)), finalIteration("改完了")]);
  const events: any[] = [];
  try {
    const loop = new AgenticLoop(provider as any, registry(), { maxIterations: 12, model: "m", securityMode: "full" } as any);
    for await (const ev of loop.run(session, "多编辑部分失败时的状态不对，修一下", cwd, "system prompt")) events.push(ev);
  } finally {
    spy.mockRestore();
    delete (globalThis as any).__CODEM_DEBUG__;
    resetDebugCache();
  }
  return { produced: logs.filter((l) => l.includes("symbol siblings:") && !l.includes("null")).length, events };
}

describe("第 133 波：同族判据不该被第一次编辑一次性用掉", () => {
  it("SSB-5: 先编辑一个「没有同族判据」的文件 ⇒ 之后编辑有同族判据的文件仍要提示", async () => {
    const cwd = workspace();
    try {
      const { produced, events } = await runEdits("ssb5-session", cwd, [
        join(cwd, "src", "core", "llm", "index.ts"), // 第一次：无同族判据 ⇒ null
        join(cwd, "src", "core", "llm", "tools.ts"), // 第二次：有 ⇒ 必须提示 ✓
      ]);
      expect(produced, "第二次编辑必须真的产出提示").toBeGreaterThanOrEqual(1);
      const text = events.map((e) => JSON.stringify(e)).join("\n");
      expect(text, "而且要能看见那条判据文件").toContain("dsh-d9-multi-edit-partial-failure.test.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("SSB-6 反向对照: 同一个文件编辑多次 ⇒ 只产出一次（不许刷屏）", async () => {
    const cwd = workspace();
    try {
      const same = join(cwd, "src", "core", "llm", "tools.ts");
      const { produced } = await runEdits("ssb6-session", cwd, [same, same, same]);
      expect(produced, `同一个文件重复编辑只应产出一次提示（实际 ${produced} 次）`).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
