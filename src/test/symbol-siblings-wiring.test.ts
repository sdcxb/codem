/**
 * 第 125/126 波：**"同族判据"那条事实的接线判据** —— 它真的在编辑之后到模型面前了吗？
 *
 * 夹具照抄 `family-reminder-wiring.test.ts`（那套已验证能真正派发工具 ✓，
 * 并且用 `vi.mock("../core/file-api")` 走**生产同一条 IPC 路径** ✓）。
 *
 * 前提断言（吃过两次亏 ✗）：① 假工具必须真的被派发；② 编辑类工具名必须是 `edit` ✓；
 * ③ 工作区里那个符号必须真的被某个测试文件提到（否则这条判据恒真 ✗）。
 *
 * 变异自证：把接线里"编辑后追加"那段删掉 ⇒ 本判据红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

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
          const text = readFileSync(full, "utf8");
          if (text.includes(pattern)) out.push(`${rel}:1: ${pattern}`);
        }
      };
      walk(root, "", 0);
      return out;
    },
  };
});

const MESSAGE = "多编辑部分失败时的状态不对，修一下。";

class ScriptedProvider {
  id = "symbol-siblings-provider";
  name = "Siblings Mock";
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

function finalIteration(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

function registryWithFakeEdit(file: string) {
  const registry = createDefaultToolRegistry();
  const executed: string[] = [];
  registry.register({
    id: "edit",
    description: "假 edit（判据夹具）",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute(args: any) {
      executed.push(String(args?.path ?? ""));
      return { title: `edit ${file}`, output: `Successfully edited ${file}` };
    },
  } as any);
  return { registry, executed };
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "codem-siblings-wiring-"));
  mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
  mkdirSync(join(root, "src", "test"), { recursive: true });
  writeFileSync(join(root, "src", "core", "llm", "tools.ts"), "export function applyToolResultStatus() {}\n");
  writeFileSync(join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"), "// applyToolResultStatus 的判据\n");
  return root;
}

function textOf(provider: ScriptedProvider, events: any[] = []): string {
  const fromRequests = provider.requests
    .map((r) => (r?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"))
    .join("\n");
  return fromRequests + "\n" + events.map((e) => JSON.stringify(e)).join("\n");
}

describe("第 125 波：同族判据的接线", () => {
  it("SSB-W1: 编辑之后，「同族判据」那条事实确实出现在模型看到的文本里", async () => {
    const cwd = workspace();
    try {
      const provider = new ScriptedProvider();
      provider.setScript([
        editIteration("e1", join(cwd, "src", "core", "llm", "tools.ts")),
        finalIteration("改完了"),
      ]);
      const { registry, executed } = registryWithFakeEdit(join(cwd, "src", "core", "llm", "tools.ts"));
      const loop = new AgenticLoop(provider as any, registry, { maxIterations: 8, model: "m", securityMode: "full" } as any);
      const events: any[] = [];
      for await (const ev of loop.run("siblings-session-1", MESSAGE, cwd, "system prompt")) events.push(ev);

      expect(executed.length, "夹具前提：假 edit 必须真的被派发").toBeGreaterThan(0);
      const text = textOf(provider, events);
      expect(text, "编辑之后必须给出同族判据").toContain("[同族判据]");
      expect(text, "而且要能看见那条判据文件").toContain("dsh-d9-multi-edit-partial-failure.test.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("SSB-W2 反向对照: 没编辑任何文件 ⇒ 不该出现这段（否则每轮都塞噪声）", async () => {
    const cwd = workspace();
    try {
      const provider = new ScriptedProvider();
      provider.setScript([finalIteration("直接回答")]);
      const { registry } = registryWithFakeEdit(join(cwd, "src", "core", "llm", "tools.ts"));
      const loop = new AgenticLoop(provider as any, registry, { maxIterations: 4, model: "m", securityMode: "full" } as any);
      for await (const _ev of loop.run("siblings-session-2", MESSAGE, cwd, "system prompt")) {
        /* 只驱动 */
      }
      expect(textOf(provider)).not.toContain("[同族判据]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
