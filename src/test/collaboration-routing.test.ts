/**
 * 协作路由的判据（场景 → 工具）。
 *
 * 这组用例钉两件事：
 * 1. **命中要对**：用户说"开个团队 / 交给另一个会话 / 并行做"时，路由到对应机制；
 *    说"修个 bug"时不注入（否则就是每轮都在唠叨，白烧 token）；
 * 2. **提示要可执行**：给的是"第一步调哪个工具 + 什么时候不该用"，不是"你可以考虑协作"。
 *
 * 端到端部分（注入位置）沿用 D5 的取证方式：抓**真实发给 provider 的请求**，
 * 断言提示在尾部、且不进 system 前缀。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  buildCollaborationRoutingHint,
  detectCollaborationRoutes,
} from "../core/llm/collaboration-routing";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { clearTimeContext } from "../core/llm/time-context";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const SESSION = "collab-routing";
const CWD = "C:\\collab-routing";
const SYSTEM_PROMPT = "你是测试用助手。这是系统提示，必须逐字节稳定。";

class RecordingProvider {
  id = "cr-provider";
  name = "Collab Routing Mock";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

async function runOnce(message: string): Promise<RecordingProvider> {
  const provider = new RecordingProvider();
  const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
    maxIterations: 2,
    model: "cr-model",
    securityMode: "full",
    enableCompaction: false,
    contextWindow: 128000,
  });
  for await (const _e of loop.run(SESSION, message, CWD, SYSTEM_PROMPT)) {
    /* drain */
  }
  return provider;
}

const lastMessage = (p: RecordingProvider) => String(p.requests[0].messages[p.requests[0].messages.length - 1].content);

beforeEach(() => {
  clearTimeContext(SESSION);
  setStoragePort(null);
});

describe("协作路由：意图识别", () => {
  it("ROUTE-1: 团队 / 委派 / 并行 三类说法各自命中", () => {
    expect(detectCollaborationRoutes("开个团队把这件事做了").map((h) => h.route)).toContain("team");
    expect(detectCollaborationRoutes("帮我组个队，多角色分工").map((h) => h.route)).toContain("team");
    expect(detectCollaborationRoutes("把剩下的活交给另一个会话").map((h) => h.route)).toContain("delegation");
    expect(detectCollaborationRoutes("这两块并行做，分头推进").map((h) => h.route)).toContain("subagent");
    expect(detectCollaborationRoutes("团队现在谁在干什么").map((h) => h.route)).toContain("team-status");
  });

  it("ROUTE-2: 普通请求不误报（不注入 = 不唠叨）", () => {
    for (const text of ["修一下这个 bug", "写个 README", "跑一下测试", "解释这段代码", "add a button"]) {
      expect(detectCollaborationRoutes(text), `不该路由：${text}`).toEqual([]);
      expect(buildCollaborationRoutingHint(text), `不该注入：${text}`).toBe("");
    }
  });

  it("ROUTE-3: 提示给的是「第一步调什么 + 什么时候不该用」", () => {
    const team = buildCollaborationRoutingHint("开个团队搞定它");
    expect(team).toContain("squad_list");
    expect(team).toContain("squad_dispatch");
    expect(team).toContain("agent_teams_create");
    expect(team, "必须写出反例，否则模型会对所有任务都建团队").toContain("不该用");

    const delegation = buildCollaborationRoutingHint("交给另一个会话接着做");
    expect(delegation).toContain("delegate_to_session");
    expect(delegation).toContain("handoff_to_new_session");
    expect(delegation, "要给出更轻的替代（只想要结论时）").toContain("subagent");

    const parallel = buildCollaborationRoutingHint("这两块并行做");
    expect(parallel).toContain("subagent");
    expect(parallel, "用户要能接手时该换成交接").toContain("handoff_to_new_session");
  });

  it("ROUTE-4: 一回合最多两条（再多就成说明书）", () => {
    const hint = buildCollaborationRoutingHint("开个团队，把活交给另一个会话并行做");
    const sections = hint.split("## Collaboration routing")[1] ?? "";
    const count = (sections.match(/^用户说的是/gm) ?? []).length;
    expect(count).toBeLessThanOrEqual(2);
  });
});

describe("协作路由：注入位置", () => {
  it("ROUTE-5: 命中时到达模型（尾部），且不进 system 前缀", async () => {
    const provider = await runOnce("开个团队，把这件事按角色拆开做");
    const system = String(provider.requests[0].messages[0].content);
    expect(system, "路由提示绝不能进 system 前缀（会击穿缓存）").not.toContain("Collaboration routing");
    expect(lastMessage(provider), "命中时必须真的到模型").toContain("Collaboration routing");
    expect(lastMessage(provider)).toContain("squad_list");
  });

  it("ROUTE-6: 没命中时一个字都不注入", async () => {
    const provider = await runOnce("帮我修一下这个 bug");
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain("Collaboration routing");
  });
});
