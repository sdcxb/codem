/**
 * 变异波次：**运行中追加的消息必须可见、附件必须到模型**。
 *
 * 三条真机缺陷的证据链：
 * 1. 消费时不落库 ⇒ 界面没有可持久显示的载体（刷新即消失）；
 * 2. 附件不进队列 ⇒ 图片永远到不了模型（图片块是从落库消息的 attachments 转出来的）；
 * 3. 显示口径写错 ⇒ 用户看到英文模板而不是自己写的话。
 */
export default {
  description:
    "运行中追加：消费时落库成 user 消息、附件随消息落库并被转成 image block、界面显示用户原文（判据 GUIDE-VIS-1..5 / GUIDE-ATT-1..3）",
  mutations: [
    {
      id: "MUT-1 消费时不落库（回到「临时消息」旧行为）",
      why: "GUIDE-VIS-1/2：不落库就没有历史里的那条消息，界面与刷新后都看不到，模型也只能看到临时副本",
      patches: [
        {
          file: "src/core/llm/agentic-loop.ts",
          from: "          this.getMessageStorage().createMessage(persistedMessage, sessionId);",
          to: "          void persistedMessage;",
        },
      ],
      tests: ["src/test/guidance-visible-and-attachments.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 队列丢掉附件（回到只传文本）",
      why: "GUIDE-ATT-1/2：附件不进消息 ⇒ 图片块不存在 ⇒ 模型看不到图（真机报的形态）",
      patches: [
        {
          file: "src/core/llm/guidance-queue.ts",
          from: "      ...(files ? { attachments: files } : {}),",
          to: "      ...(files ? { attachments: undefined } : {}),",
        },
      ],
      tests: ["src/test/guidance-visible-and-attachments.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 显示口径退回「直接显示落库正文」",
      why: "GUIDE-VIS-5：正文是模板形态，直接显示会让用户看到 `Runtime guidance from the user`",
      patches: [
        {
          file: "src/core/llm/guidance-display.ts",
          from: "export function guidanceDisplayMessage(message: GuidanceDisplayMessage): string {\n  if (!isMidTurnGuidance(message)) return message.content;",
          to: "export function guidanceDisplayMessage(message: GuidanceDisplayMessage): string {\n  return message.content;",
        },
      ],
      tests: ["src/test/guidance-visible-and-attachments.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 多模态附件不做按 id 取回（只读 att.content）",
      why: "GUIDE-ATT-1：索引投影会抹掉附件正文，不按 id 取回就永远拿不到图片块",
      patches: [
        {
          file: "src/core/storage/message.ts",
          from: "      const mediaAttachments = (msg.attachments || [])\n        .filter((a) => a.type === \"image\" || a.type === \"audio\")\n        .map((a) => ({ ...a, content: resolveMediaContent(a) }))\n        .filter((a) => a.content);",
          to: "      const mediaAttachments = (msg.attachments || []).filter(\n        (a) => (a.type === \"image\" || a.type === \"audio\") && a.content\n      );",
        },
      ],
      tests: ["src/test/guidance-visible-and-attachments.test.ts"],
      expectRed: true,
    },
  ],
};
