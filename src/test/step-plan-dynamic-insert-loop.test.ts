/**
 * 集成测试：语义计划 + update_plan 动态插入（loop 全链路）
 *
 * 对标 dsh-desktop 客户端 todo 语义列表，验证 agentic-loop 真实运行路径：
 *   STEP-L1 执行型任务在 run 开始时生成 LLM 语义计划（4 步），UI 收到
 *           step_progress(1/4, steps=4)
 *   STEP-L2 执行类工具（bash）推进 X/X；侦查/计划元操作不推进
 *   STEP-L3 执行到第 3 步时模型调用 update_plan insert_before index=3 →
 *           "修复调用链路"插入成为新第 3 步，step_progress 刷新为 3/5
 *           （编号顺延：原"修复卡死"变第 4 步）
 *   STEP-L4 update_plan 不推进宏步骤（插入前后 current 保持）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockReadFile, mockWriteFile, mockExecuteCommand } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockExecuteCommand: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  exists: vi.fn().mockReturnValue(true),
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  listDirectory: vi.fn().mockReturnValue([]),
  deletePath: vi.fn(),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";

const SESSION_ID = "sess-plan-loop";
const PROJECT_ID = "proj-plan-loop";

/** 事件脚本驱动的 mock provider：stream 逐 iteration 消费；complete 逐次返回。 */
class ScriptedProvider {
  id = "mock-provider";
  config: any = {};
  dynamicModels: any[] | null = null;
  private streamQueue: any[][] = [];
  private completeQueue: any[] = [];

  setScript(scripts: any[][]) {
    this.streamQueue = scripts;
  }
  setCompleteReplies(replies: any[]) {
    this.completeQueue = replies;
  }
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    const script = this.streamQueue.length > 0 ? this.streamQueue.shift()! : [
      { type: "text_delta", text: "（脚本耗尽）" },
      { type: "end", finishReason: "stop" },
    ];
    for (const event of script) {
      yield event;
    }
  }
  async complete(_request: any) {
    const reply = this.completeQueue.length > 0 ? this.completeQueue.shift()! : { content: "{}" };
    return { content: reply.content, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
}

function toolEvents(callId: string, name: string, input: Record<string, unknown>): any[] {
  return [
    { type: "tool_use_start", id: callId, name },
    { type: "tool_use_delta", id: callId, input: JSON.stringify(input) },
    { type: "tool_use_end", id: callId, input },
    { type: "end", finishReason: "tool_use" },
  ];
}
function textEvents(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}
const PLAN_JSON = JSON.stringify([
  { title: "分析卡死原因" },
  { title: "诊断调用链路" },
  { title: "修复卡死" },
  { title: "测试验证卡死不再出现" },
]);

describe("语义计划 + update_plan 动态插入（loop 集成）", () => {
  let provider: ScriptedProvider;
  let loop: AgenticLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecuteCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockWriteFile.mockResolvedValue(undefined);
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    ProjectStorage.createProject({
      id: PROJECT_ID,
      name: "计划测试项目",
      path: "C:\\plan-test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "计划测试会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
    provider = new ScriptedProvider();
    const registry = createDefaultToolRegistry();
    loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "mock-model",
      securityMode: "full",
    });
  });

  it("STEP-L1+L2+L3+L4: 语义计划→执行推进→第3步前插入→刷新 3/5", async () => {
    // 规划：1 次 complete 返回 4 步语义计划
    provider.setCompleteReplies([{ content: PLAN_JSON }]);
    // 执行流：
    //  it1 bash（执行工具：1→2）→ it2 bash（2→3）→
    //  it3 update_plan insert_before index=3（recon 不推进；插入"修复调用链路"）→
    //  it4 文本收尾
    provider.setScript([
      toolEvents("tc-1", "bash", { command: "echo probe-1" }),
      toolEvents("tc-2", "bash", { command: "echo probe-2" }),
      toolEvents("tc-3", "update_plan", { action: "insert_before", index: 3, titles: ["修复调用链路"] }),
      textEvents("完成"),
    ]);

    const progresses: any[] = [];
    let result: any;
    for await (const event of loop.run(
      SESSION_ID,
      "修复页面卡死的问题",
      "C:\\plan-test",
      "system prompt",
    )) {
      if (event.type === "step_progress") progresses.push(event);
      if (event.type === "end") result = event.result;
    }

    // STEP-L1: 计划阶段产生 4 步语义计划
    const first = progresses[0];
    expect(first.step).toBe(1);
    expect(first.total).toBe(4);
    expect(first.steps.map((s: any) => s.title)).toEqual([
      "分析卡死原因", "诊断调用链路", "修复卡死", "测试验证卡死不再出现",
    ]);

    // STEP-L2: bash 推进（出现过 step=2、step=3 的事件）
    const stepsSeen = progresses.map((p) => p.step);
    expect(stepsSeen).toContain(2);
    expect(stepsSeen).toContain(3);

    // STEP-L3: update_plan 插入后 → total 5，第 3 步是"修复调用链路"，原"修复卡死"顺延为 4
    const afterInsert = progresses.find((p) => p.total === 5);
    expect(afterInsert).toBeTruthy();
    expect(afterInsert.step).toBe(3); // STEP-L4: 插入不推进当前步骤
    expect(afterInsert.steps.map((s: any) => s.title)).toEqual([
      "分析卡死原因", "诊断调用链路", "修复调用链路", "修复卡死", "测试验证卡死不再出现",
    ]);
    expect(afterInsert.title).toBe("修复调用链路");

    // 事件顺序：插入后的事件出现在 tool 相关事件之后（刷新 step_progress 由 tool_result 触发）
    const insertIdx = progresses.findIndex((p) => p.total === 5);
    expect(insertIdx).toBeGreaterThan(0);
    expect(result).toBeTruthy();
  });

  it("STEP-L6: LLM 语义计划耗尽后不自动追加泛化步骤（total 保持计划数）", async () => {
    // 2 步语义计划；执行工具超过计划轮数 → 不再出现"执行命令"式第 3 步
    provider.setCompleteReplies([{ content: JSON.stringify([{ title: "分析原因" }, { title: "修复卡死" }]) }]);
    provider.setScript([
      toolEvents("tc-1", "bash", { command: "echo a" }),
      toolEvents("tc-2", "bash", { command: "echo b" }), // 计划耗尽后的新执行
      toolEvents("tc-3", "bash", { command: "echo c" }), // 再次执行，也不追加
      textEvents("完成"),
    ]);

    const progresses: any[] = [];
    for await (const event of loop.run(
      SESSION_ID,
      "修复页面卡死的问题",
      "C:\\plan-test",
      "system prompt",
    )) {
      if (event.type === "step_progress") progresses.push(event);
    }

    const totals = new Set(progresses.map((p) => p.total));
    const maxStep = Math.max(...progresses.map((p) => p.step));
    expect(totals).toEqual(new Set([2])); // 永不出现第 3 步
    expect(maxStep).toBe(2);
    // 标题保持最后计划步的语义标题
    const last = progresses[progresses.length - 1];
    expect(last.title).toBe("修复卡死");
  });

  it("STEP-L7: 模型规划返回空白标题 → 清洗后回退启发式计划（不出现空白步骤）", async () => {
    // complete 返回空/空白标题数组 → planSteps 清洗后为空 → fromLlm=false 启发式兜底
    provider.setCompleteReplies([{ content: JSON.stringify([{ title: "  " }, {}, { title: "" }]) }]);
    provider.setScript([
      toolEvents("tc-1", "bash", { command: "echo probe" }),
      textEvents("完成"),
    ]);

    const progresses: any[] = [];
    for await (const event of loop.run(
      SESSION_ID,
      "修复页面卡死的问题",
      "C:\\plan-test",
      "system prompt",
    )) {
      if (event.type === "step_progress") progresses.push(event);
    }

    // 回退启发式任务计划（分析：<任务> / 定位问题根因 / 实施修复并验证 → total=3）
    const last = progresses[progresses.length - 1];
    expect(last.total).toBeGreaterThan(0);
    // 任何展示的步骤标题都非空
    for (const p of progresses) {
      if (p.steps) {
        for (const s of p.steps) {
          expect(String(s.title).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("STEP-L8: 插入后继续执行 — 后续推进进入顺延后的语义步骤", async () => {
    // 4 步语义计划；执行到第 2 步时发现第 3 步前需插入新步骤；之后继续推进
    provider.setCompleteReplies([{ content: PLAN_JSON }]);
    provider.setScript([
      toolEvents("tc-1", "bash", { command: "echo a" }), // 1→2
      toolEvents("tc-2", "update_plan", { action: "insert_before", index: 3, titles: ["修复调用链路"] }), // 5 步，macroStep=2 不动
      toolEvents("tc-3", "bash", { command: "echo b" }), // 2→3 = 修复调用链路
      toolEvents("tc-4", "bash", { command: "echo c" }), // 3→4 = 修复卡死（原第 3 步顺延）
      textEvents("完成"),
    ]);

    const progresses: any[] = [];
    for await (const event of loop.run(
      SESSION_ID,
      "修复页面卡死的问题",
      "C:\\plan-test",
      "system prompt",
    )) {
      if (event.type === "step_progress") progresses.push(event);
    }

    // 推进到第 3 步时标题 = 新插入的"修复调用链路"
    const at3 = progresses.find((p) => p.step === 3 && p.total === 5);
    expect(at3).toBeTruthy();
    expect(at3.title).toBe("修复调用链路");
    // 继续推进到第 4 步 → 原"修复卡死"顺延为新第 4 步
    const at4 = progresses.find((p) => p.step === 4 && p.total === 5);
    expect(at4).toBeTruthy();
    expect(at4.title).toBe("修复卡死");
  });

  it("STEP-L9: loop 层拒绝插入已完成区段 — 计划不变、错误回给模型", async () => {
    provider.setCompleteReplies([{ content: PLAN_JSON }]);
    provider.setScript([
      toolEvents("tc-1", "bash", { command: "echo a" }), // 1→2（第 1 步已完成）
      toolEvents("tc-2", "update_plan", { action: "insert_before", index: 1, titles: ["非法插入"] }), // 拒绝
      textEvents("完成"),
    ]);

    const progresses: any[] = [];
    const toolResults: any[] = [];
    for await (const event of loop.run(
      SESSION_ID,
      "修复页面卡死的问题",
      "C:\\plan-test",
      "system prompt",
    )) {
      if (event.type === "step_progress") progresses.push(event);
      if (event.type === "tool_complete" || event.type === "tool_result") toolResults.push(event);
    }

    // 计划未被修改：total 恒 4，无第 5 步
    const totals = new Set(progresses.map((p) => p.total));
    expect(totals).toEqual(new Set([4]));
    // 错误提示回给模型（工具结果含拒绝原因）
    const anyResult = JSON.stringify(toolResults);
    expect(anyResult).toContain("只能插入到当前进行中的");
  });

  it("STEP-L5: 纯问答不生成多步计划（不调用规划 complete 也不展示语义步骤）", async () => {
    // 纯问答：looksLikeExecutableTask=false → 不调 planSteps → complete 不会被调用
    provider.setCompleteReplies([{ content: PLAN_JSON }]); // 若被误调用也不该生效
    provider.setScript([textEvents("你好！我是 Codem。")]);

    const progresses: any[] = [];
    let completeCalled = 0;
    const origComplete = provider.complete.bind(provider);
    provider.complete = async (req: any) => { completeCalled++; return origComplete(req); };

    for await (const event of loop.run(SESSION_ID, "你好", "C:\\plan-test", "system prompt")) {
      if (event.type === "step_progress") progresses.push(event);
    }

    // 纯问答不应展示语义计划：total 为启发式 1（回答问题单步）且未调用规划
    const last = progresses[progresses.length - 1];
    expect(last.total).toBe(1);
    expect(completeCalled).toBe(0);
  });
});
