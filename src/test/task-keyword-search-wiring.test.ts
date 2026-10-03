/**
 * 第 98 波：**接线判据** —— "任务关键词命中"真的到模型面前了吗？
 *
 * 本项目吃过"注入是死代码"的亏（`goal-injection.test.ts` 当年用**源码文本**把一段永远不生效的
 * 注入钉成"绿" ✗）。所以这里**真跑 loop，看 provider 收到的消息** ✓。
 *
 * 调用形状照抄 `red-test-at-completion.test.ts`（已验证可用）。
 *
 * 变异自证：删掉 `agentic-loop.ts` 里的注入段 ⇒ TSW-1 红；去掉按会话去重 ⇒ TSW-3 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

class ScriptedProvider {
  id = "task-search-provider";
  name = "Search Mock";
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
    const script = this.queue.shift() ?? [];
    for (const ev of script) yield ev;
  }
  async complete() {
    return { content: "ok" };
  }
}

/** 造一个"有测试文件、且测试文件里含任务关键词"的工作区 */
function workspaceWithMatchingTest() {
  const root = mkdtempSync(join(tmpdir(), "codem-search-loop-"));
  mkdirSync(join(root, "src", "test"), { recursive: true });
  writeFileSync(join(root, "src", "test", "cache-buckets.test.ts"), "// 记账 buckets 记账 记账\n");
  writeFileSync(join(root, "src", "test", "unrelated.test.ts"), "// nothing\n");
  return root;
}

function allText(req: any): string {
  return (req?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

function toolIteration(id: string, command: string): any[] {
  return [
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_delta", id, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

async function runSession(cwd: string, session: string, scripts: any[][], message: string, maxIterations = 6) {
  const provider = new ScriptedProvider();
  provider.setScript(scripts);
  const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), { maxIterations, model: "m", securityMode: "full" } as any);
  for await (const _ev of loop.run(session, message, cwd, "system prompt")) {
    // 只驱动
  }
  return provider;
}

describe("第 98 波：任务关键词搜索的接线", () => {
  it("TSW-1: provider 真的收到了命中清单（不是死代码）", async () => {
    const cwd = workspaceWithMatchingTest();
    try {
      const provider = await runSession(cwd, "search-session-1", [[]], "记账的桶数不对，账单上数字明显偏低");
      const text = provider.requests.map(allText).join("\n");
      expect(provider.requests.length).toBeGreaterThan(0);
      expect(text, "命中清单必须出现在模型看到的文本里").toContain("cache-buckets.test.ts");
      expect(text).toContain("[任务关键词命中]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("TSW-2 反向对照: 消息与仓库毫无关系时，不许凭空造一段清单", async () => {
    const cwd = workspaceWithMatchingTest();
    try {
      const provider = await runSession(cwd, "search-session-2", [[]], "量子纠缠与风笛的历史渊源");
      const text = provider.requests.map(allText).join("\n");
      expect(text).not.toContain("[任务关键词命中]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("TSW-3: 清单按会话只注入一次（重复注入只是白烧 token）", async () => {
    const cwd = workspaceWithMatchingTest();
    try {
      const provider = await runSession(cwd, "search-session-3", [toolIteration("c1", "echo hi"), finalIteration("完成")], "记账的桶数不对");
      const counts = provider.requests.map((r) => allText(r).split("[任务关键词命中]").length - 1);
      expect(provider.requests.length, "同一会话里必须被请求 ≥2 次，否则这条判据恒真、测不到东西").toBeGreaterThanOrEqual(2);
      const total = counts.reduce((a, b) => a + b, 0);
      expect(total, `整场会话里只该出现一次（实测各次：${counts.join(",")}）`).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
