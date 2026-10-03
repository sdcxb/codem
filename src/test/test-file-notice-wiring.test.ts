/**
 * 第 94 波：**接线判据** —— "工作区测试文件清单"真的到模型面前了吗？
 *
 * ## 为什么必须有这一条
 *
 * 本项目吃过一次"注入是死代码"的亏（`goal-injection.test.ts` 当年用**源码文本**把一段
 * 永远不生效的注入钉成"绿" ✗）。所以这里**不看源码里有没有那行字**，
 * 而是**真跑 loop，去看 provider 收到的消息里有没有那份清单** ✓。
 *
 * 调用形状照抄 `red-test-at-completion.test.ts`（那套夹具已被验证可用）：
 * `new AgenticLoop(provider, registry, { maxIterations, model, securityMode })`。
 *
 * 变异自证：删掉 `agentic-loop.ts` 里那段注入 ⇒ TFN-W1 红；
 * 去掉 `this.testFileNoticeSent` 去重 ⇒ TFN-W3 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

/** 脚本化 provider（与 stall-guard / red-test 判据同款） */
class ScriptedProvider {
  id = "test-file-notice-provider";
  name = "Notice Mock";
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

function workspaceWithTests() {
  const root = mkdtempSync(join(tmpdir(), "codem-notice-loop-"));
  mkdirSync(join(root, "src", "test"), { recursive: true });
  writeFileSync(join(root, "src", "test", "visible-criterion.test.ts"), "// x");
  return root;
}

/** 把一次请求里所有消息的文本拼起来 */
function allText(req: any): string {
  return (req?.messages ?? [])
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** 一个带工具调用的迭代（事件形状照抄 red-test-at-completion 的 `testIteration`） */
function toolIteration(id: string, command: string): any[] {
  return [
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_delta", id, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/** 收尾迭代：只有文本、没有工具调用 */
function finalIteration(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

/** 跑一个会话；返回 provider（里面有每次请求） */
async function runSession(cwd: string, session: string, scripts: any[][], maxIterations = 4) {
  const provider = new ScriptedProvider();
  provider.setScript(scripts);
  const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
    maxIterations,
    model: "m",
    securityMode: "full",
  } as any);
  const events: any[] = [];
  for await (const ev of loop.run(session, "看一下这个任务", cwd, "system prompt")) {
    events.push(ev);
  }
  return { provider, events };
}

describe("第 94 波：测试文件清单的接线", () => {
  it("TFN-W1: provider 真的收到了清单（不是死代码）", async () => {
    const cwd = workspaceWithTests();
    try {
      const { provider } = await runSession(cwd, "notice-session-1", [[]]);
      const text = provider.requests.map(allText).join("\n");
      expect(provider.requests.length, "至少要发出一次请求").toBeGreaterThan(0);
      expect(text, "清单必须出现在模型看到的文本里").toContain("visible-criterion.test.ts");
      expect(text).toMatch(/测试文件/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("TFN-W2 反向对照: 工作区没有测试文件时不该凭空造一段清单", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-notice-empty-"));
    try {
      writeFileSync(join(root, "readme.md"), "# 没有测试");
      const { provider } = await runSession(root, "notice-session-2", [[]]);
      const text = provider.requests.map(allText).join("\n");
      expect(text).not.toContain("[工作区测试文件]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TFN-W3: 清单按会话只注入一次（重复注入只会白烧 token）", async () => {
    const cwd = workspaceWithTests();
    try {
      const { provider } = await runSession(
        cwd,
        "notice-session-3",
        [toolIteration("c1", "echo hi"), finalIteration("完成")],
        6,
      );
      const counts = provider.requests.map((r) => allText(r).split("[工作区测试文件]").length - 1);
      /**
       * ⚠️ **先断言场景真的成立**（第 94 波踩到）：这条判据第一版没有这句话，
       * 脚本其实只跑出 **1 次**请求 ⇒ "只注入一次"**恒真** ✗，
       * 去掉去重代码它照样绿（变异没被咬住 ⇒ 判据是空的 ✗）。
       * 所以：必须先证明"同一会话里被请求了 ≥2 次"，这条判据才有意义。
       */
      expect(provider.requests.length, "同一会话里必须被请求 ≥2 次，否则这条判据恒真、测不到东西").toBeGreaterThanOrEqual(2);
      const total = counts.reduce((a, b) => a + b, 0);
      expect(total, `整场会话里清单只该出现一次（实测各次：${counts.join(",")}）`).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
