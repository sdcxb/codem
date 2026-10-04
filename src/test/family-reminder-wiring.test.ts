/**
 * 第 109 波：**判据族提醒的接线判据** —— 它真的在「测试红了」之后到模型面前了吗？
 *
 * ⚠️ 这份夹具是**照抄** `red-test-at-completion.test.ts`（那套已被验证能真正派发 bash 工具 ✓）：
 * provider（含 `listModels` / 脚本耗尽即抛）、`registryWithFakeBash`、`drain` 三件套都逐字搬过来，
 * 只改两处：① CWD 指向一个**真实的临时工作区**（族提醒需要 ≥50 个测试文件才有意义）；
 * ② 假 bash 的输出里留一个 `FAKE_BASH_MARKER`，用来**先证明场景成立**。
 *
 * 为什么这么谨慎：我自己那版夹具（自造 provider + 自造注册）跑出来**根本没有派发工具** ✗，
 * 于是判据永远进不了 RED TEST 分支 —— 与前面三次"夹具不成立"是同一类坑 ✗。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

const TEST_MESSAGE = "记账的桶数不对，用量面板数字偏低 usage，把仓库改好并跑测试验证。";

class ScriptedProvider {
  id = "family-reminder-provider";
  name = "Family Reminder Mock";
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
    if (!script) throw new Error("脚本耗尽（不该发生的额外调用）");
    for (const item of script) yield item;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
}

/** 一个"跑测试"的迭代：调用 bash，然后 finishReason=tool_use（循环继续） */
function testIteration(id: string, command: string): any[] {
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

/** 假的 bash（形状与 red-test 判据里的 `registryWithFakeBash` 一致） */
const RED_OUTPUT = `
 FAKE_BASH_MARKER
 ❯ src/test/dsh-d9-usage-bucket.test.ts (4 tests | 1 failed)
 ❯ src/test/usage-normalize.test.ts (3 tests | 2 failed)
 Test Files  2 failed | 1 passed (3)
      Tests  3 failed | 5 passed (8)
`;

function registryWithFakeBash(output: string) {
  const registry = createDefaultToolRegistry();
  const executed: string[] = [];
  registry.register({
    id: "bash",
    description: "假 bash（判据夹具：测试输出由用例给）",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute(args: any) {
      const command = String(args?.command ?? "");
      executed.push(command);
      return { title: `bash: ${command}`, output };
    },
  } as any);
  return { registry, executed };
}

async function drain(loop: AgenticLoop, cwd: string, session: string): Promise<any[]> {
  const events: any[] = [];
  for await (const event of loop.run(session, TEST_MESSAGE, cwd, "system prompt")) {
    events.push(event);
  }
  return events;
}

/** 够大的工作区（≥50 个测试文件才会给族提醒）+ 一个含任务词的族 */
function bigWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "codem-family-wiring-"));
  mkdirSync(join(root, "src", "test"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", "test", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");
  writeFileSync(join(root, "src", "test", "dsh-d9-usage-bucket.test.ts"), "// 记账 usage\n");
  return root;
}

/**
 * 把"模型看到的文本"拼起来：**请求消息 + 事件**都要看。
 *
 * ⚠️ 第 109 波踩到：我第一版只看 `provider.requests` ✗ —— 而工具结果（连带附在它后面的指针/提醒）
 * 在**事件流**里（`red-test-at-completion.test.ts` 一直是断言事件 ✓）。只看请求会误判成"没注入" ✗。
 */
function textOf(provider: ScriptedProvider, events: any[] = []): string {
  const fromRequests = provider.requests
    .map((r) => (r?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"))
    .join("\n");
  return fromRequests + "\n" + events.map((e) => JSON.stringify(e)).join("\n");
}

describe("第 109 波：判据族提醒的接线", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = bigWorkspace();
  });

  it("TFR-W1: 测试红了之后，族提醒确实出现在模型看到的文本里", async () => {
    try {
      const provider = new ScriptedProvider();
      provider.setScript([testIteration("c1", "npx vitest run src/test/dsh-d9-usage-bucket.test.ts"), finalIteration("改完了")]);
      const { registry, executed } = registryWithFakeBash(RED_OUTPUT);
      const loop = new AgenticLoop(provider as any, registry, { maxIterations: 10, model: "m", securityMode: "full" } as any);
      const events = await drain(loop, cwd, "family-session-1");

      expect(executed.length, "假 bash 必须真的被派发（否则场景从根上不成立）").toBeGreaterThan(0);
      const text = textOf(provider, events);
      expect(text, "场景必须先成立：得真的跑出红（否则这条判据恒真）").toContain("[RED TEST]");
      expect(text, "红了之后必须补发族提醒").toContain("[判据族提醒]");
      expect(text, "提醒里要能看到那一族的成员").toContain("dsh-d9-usage-bucket.test.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("TFR-W2 反向对照: 没跑测试（没有红）就不该补发（否则每轮都塞一段噪声）", async () => {
    try {
      const provider = new ScriptedProvider();
      provider.setScript([testIteration("c1", "echo hi"), finalIteration("完成")]);
      const { registry } = registryWithFakeBash("hello");
      const loop = new AgenticLoop(provider as any, registry, { maxIterations: 10, model: "m", securityMode: "full" } as any);
      await drain(loop, cwd, "family-session-2");

      const text = textOf(provider);
      expect(text).not.toContain("[RED TEST]");
      expect(text).not.toContain("[判据族提醒]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
