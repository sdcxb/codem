/**
 * GUIDE-VIS / GUIDE-ATT：运行中追加的消息**必须看得见**，追加的附件**必须到模型**。
 *
 * ## 真机缺陷（2026-10-18，用户直报）
 *
 * 1. 对话执行中追加一句话、点「立刻引导」之后，界面上**什么都不剩**：
 *    状态栏气泡被删、对话流里没有新消息、刷新后彻底消失 —— 用户无法判断是否成功。
 * 2. 追加时贴了一张图，模型回复"没看到图片"。
 *
 * ## 根因
 *
 * 引导消息在消费点被拼成一条**只活在本次请求里**的临时 user 消息（不落库、不建索引），
 * 且 `onSendGuidance(message)` 签名只有文本 —— 附件在 UI 层就被丢掉。
 * 于是：① 界面没有可持久显示的载体；② 图片块根本不存在（图片是**从落库消息的
 * attachments** 转出来的，见 `storage/message.ts` 的 `messagesToLLMMessages`）。
 *
 * ## 修复后的契约（本文件钉住）
 *
 * - 消费时**落库**成真实 user 消息（模板包裹），`metadata.midTurnGuidance` + `guidanceRaw`；
 * - `guidance_received` 事件带回 `persistedMessage`（前端直接显示，不二次落库）；
 * - 附件随条目入队 → 落库 → `messagesToLLMMessages` 产出 image block；
 * - 界面显示用户原文（不是模板），这条规则由 `guidance-display.ts` 唯一实现。
 */
import { describe, it, expect, beforeEach } from "vitest";

import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import * as MessageStorage from "../core/storage/message";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { GUIDANCE_MESSAGE_TEMPLATE } from "../core/llm/guidance-queue";
import { isMidTurnGuidance, guidanceDisplayMessage } from "../core/llm/guidance-display";

const SESSION_ID = "guidance-visible-session";
const PROJECT_ID = "guidance-visible-project";
const CWD = "C:\\guidance-visible";
const SYSTEM_PROMPT = "你是测试用助手。";
const MID_TURN_TEXT = "先别动那个文件，改成先补一个失败测试";
const IMAGE_ATTACHMENT = {
  id: "att-img-1",
  name: "shot.png",
  type: "image" as const,
  mimeType: "image/png",
  size: 12,
  content: "data:image/png;base64,AAAA",
};

/** 一次会触发工具的迭代（让循环进入第二个 iteration boundary，那里才会消费引导） */
function toolIteration(id: string, pattern: string): any[] {
  return [
    { type: "tool_use_start", id, name: "glob" },
    { type: "tool_use_delta", id, input: JSON.stringify({ pattern, path: CWD }) },
    { type: "tool_use_end", id, input: { pattern, path: CWD } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

class RecordingProvider {
  id = "guidance-vis-provider";
  name = "Guidance Vis Mock";
  requests: any[] = [];
  private streamQueue: any[][] = [];
  isConfigured() {
    return true;
  }
  setScript(scripts: any[][]) {
    this.streamQueue = scripts;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.streamQueue.length > 0 ? this.streamQueue.shift()! : finalIteration("收到");
    for (const event of script) yield event;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

describe("运行中追加：可见性 + 附件", () => {
  let provider: RecordingProvider;
  let loop: AgenticLoop;

  beforeEach(() => {
    ProjectStorage.createProject({
      id: PROJECT_ID,
      name: "追加可见测试项目",
      path: CWD,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "追加可见测试会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
    provider = new RecordingProvider();
    loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 4,
      model: "guidance-model",
      securityMode: "full",
    });
  });

  /**
   * 跑一轮，并在**第一轮回合进行中**追加一条引导：
   * 先推进到工具执行，再入队 —— 下一轮 iteration boundary 会消费它。
   */
  async function runTurnWithMidTurnGuidance(text: string, attachments?: any[]) {
    provider.setScript([toolIteration("call-1", "*"), finalIteration("完成")]);
    const events: any[] = [];
    const gen = loop.run(SESSION_ID, "跑一下", CWD, SYSTEM_PROMPT);
    let first = await gen.next();
    if (!first.done) events.push(first.value);
    const item = loop.sendGuidance(text, attachments);
    expect(item, "回合进行中 sendGuidance 必须入队成功").not.toBeNull();
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
    }
    return { events, item: item! };
  }

  it("GUIDE-VIS-1: 消费时落库成真实 user 消息，并在事件里带回它", async () => {
    const { events } = await runTurnWithMidTurnGuidance(MID_TURN_TEXT);

    const received = events.filter((e) => e.type === "guidance_received");
    expect(received.length, "必须 yield guidance_received").toBe(1);
    expect(received[0].persistedMessage, "事件必须带回落入历史的那条消息（前端靠它显示）").toBeTruthy();

    const persisted = MessageStorage.listMessages(SESSION_ID).filter(
      (m: any) => String(m.id).startsWith("guidance-") && !String(m.id).startsWith("guidance-carryover-"),
    );
    expect(persisted.length, "追加消息必须落库（否则刷新即消失）").toBe(1);
    expect(persisted[0].role).toBe("user");
    // 落库正文是"给模型的形态"（附件块 + 模板 + 原文）；界面显示由 guidance-display 剥
    expect(String(persisted[0].content)).toContain(MID_TURN_TEXT);
    expect(String(persisted[0].content)).toContain("Runtime guidance from the user");
    expect(guidanceDisplayMessage({ id: persisted[0].id, content: String(persisted[0].content) })).toBe(MID_TURN_TEXT);
    const pm: any = received[0].persistedMessage;
    expect(pm.metadata?.guidanceRaw).toBe(MID_TURN_TEXT);
    expect(pm.metadata?.guidanceModelContent).toBe(GUIDANCE_MESSAGE_TEMPLATE(MID_TURN_TEXT));
    expect(pm.id).toBe(persisted[0].id);
  });

  it("GUIDE-VIS-2: 模型真的看到它，而且只有一份（不是临时注入 + 历史各一份）", async () => {
    await runTurnWithMidTurnGuidance(MID_TURN_TEXT);
    const secondRequest = provider.requests.at(-1);
    expect(secondRequest, "第二次请求应当存在（工具执行后的下一轮）").toBeTruthy();

    const occurrences = (secondRequest.messages as any[]).reduce((n, m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((b: any) => b?.text ?? "").join("\n")
        : String(m.content ?? "");
      return n + (content.includes(MID_TURN_TEXT) ? 1 : 0);
    }, 0);
    expect(occurrences, "引导正文应当恰好出现一次（重复注入会让模型看到两遍）").toBe(1);
    const modelText = JSON.stringify(secondRequest.messages);
    expect(modelText, "给模型的那一份必须带运行期指令框架").toContain("Runtime guidance from the user");
  });

  it("GUIDE-VIS-3: 后续轮次仍在历史里（持久投影，不是一次性）", async () => {
    await runTurnWithMidTurnGuidance(MID_TURN_TEXT);
    provider.setScript([finalIteration("第三轮")]);
    const before = provider.requests.length;
    for await (const _ of loop.run(SESSION_ID, "换个任务", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }
    const req = provider.requests[before];
    const seen = (req.messages as any[]).some((m) =>
      String(Array.isArray(m.content) ? JSON.stringify(m.content) : m.content).includes(MID_TURN_TEXT),
    );
    expect(seen, "落库后的追加消息应当留在后续轮次的历史里").toBe(true);
  });

  it("GUIDE-ATT-1: 追加的图片写进落库消息的附件，并被转成 image block", async () => {
    await runTurnWithMidTurnGuidance(MID_TURN_TEXT, [IMAGE_ATTACHMENT]);

    const persisted = MessageStorage.listMessages(SESSION_ID).filter(
      (m: any) => String(m.id).startsWith("guidance-") && !String(m.id).startsWith("guidance-carryover-"),
    );
    expect(persisted.length).toBe(1);
    expect(persisted[0].attachments?.length, "附件必须随消息落库").toBe(1);
    expect(persisted[0].attachments[0].name).toBe("shot.png");

    const llm = MessageStorage.messagesToLLMMessages([persisted[0]]);
    const blocks = Array.isArray(llm[0].content) ? (llm[0].content as any[]) : [];
    const imageBlock = blocks.find((b) => b.type === "image");
    expect(imageBlock, "图片必须以 image block 形式进入请求（模型才看得见）").toBeTruthy();
    expect(imageBlock.mediaType).toBe("image/png");
  });

  it("GUIDE-ATT-2: 只追加图片（不带文字）也是合法请求", async () => {
    const { item } = await runTurnWithMidTurnGuidance("", [IMAGE_ATTACHMENT]);
    expect(item.attachments?.length).toBe(1);
    const persisted = MessageStorage.listMessages(SESSION_ID).filter(
      (m: any) => String(m.id).startsWith("guidance-") && !String(m.id).startsWith("guidance-carryover-"),
    );
    expect(persisted.length, "只有附件也必须落库一条消息").toBe(1);
    expect(persisted[0].attachments?.[0]?.id).toBe(IMAGE_ATTACHMENT.id);
  });

  it("GUIDE-ATT-3: 纯文本追加不产生空附件/空 <attachment> 块", async () => {
    await runTurnWithMidTurnGuidance(MID_TURN_TEXT);
    const persisted = MessageStorage.listMessages(SESSION_ID).filter(
      (m: any) => String(m.id).startsWith("guidance-") && !String(m.id).startsWith("guidance-carryover-"),
    );
    expect(persisted[0].attachments, "没有附件时不该出现 attachments 字段").toBeUndefined();
    expect(String(persisted[0].content)).not.toContain("<attachment>");
  });
});

describe("GUIDE-VIS-5: 界面显示用户原文（唯一口径）", () => {
  const persisted = {
    role: "user",
    content: `[Attachment: shot.png | ID: x]\n\n${GUIDANCE_MESSAGE_TEMPLATE("把那个函数改名")}`,
    metadata: { midTurnGuidance: true, guidanceRaw: "把那个函数改名" },
  };

  it("追加消息：显示原文，不显示注入模板", () => {
    expect(isMidTurnGuidance(persisted)).toBe(true);
    expect(guidanceDisplayMessage(persisted)).toBe("把那个函数改名");
    expect(guidanceDisplayMessage(persisted)).not.toContain("Runtime guidance");
  });

  it("普通消息：原样返回（这条规则不许影响正常消息）", () => {
    const plain = { role: "user", content: "普通的一句" };
    expect(isMidTurnGuidance(plain)).toBe(false);
    expect(guidanceDisplayMessage(plain)).toBe("普通的一句");
  });

  it("metadata 丢了 guidRaw：退回落库正文（宁可显示模板，也不能吞内容）", () => {
    const lossy = { role: "user", content: "落库正文", metadata: { midTurnGuidance: true } };
    expect(guidanceDisplayMessage(lossy)).toBe("落库正文");
  });
});
