/**
 * 「运行中追加」（mid-turn guidance）的**显示口径**的唯一实现。
 *
 * ## 落库形态与显示形态是两件事
 *
 * 引擎落库的正文是「附件内联块 + `GUIDANCE_MESSAGE_TEMPLATE`」——
 * 模板那句 "Runtime guidance from the user … Do not treat it as a normal chat message"
 * 是给**模型**的框架，不是给用户看的；附件块（`<attachment>…</attachment>`）也是给模型的。
 * 用户在气泡里要看的是**他自己写的那句话**。
 *
 * ## 为什么不用 metadata 存原文
 *
 * 试过（`metadata.guidanceRaw`），但**索引投影不保证带回 metadata**（真机与测试里都见过
 * 只返回 id + content 的形态）。一旦 metadata 丢了，用户就会看到英文模板 —— 这是信息错位。
 * 所以显示侧一律从正文里**剥**（模板前缀与附件块都是固定形态、可无损剥离），
 * metadata 只作为"优先值"与徽标依据。
 *
 * ## 识别规则（两重）
 *
 * 1. `metadata.midTurnGuidance === true`（最准，引擎落库时打的）；
 * 2. 消息 id 前缀 `guidance-`（排除 `guidance-carryover-`）—— metadata 被投影丢掉时仍能识别；
 *    或者正文本身以模板前缀开头（更老的历史形态）。
 *
 * 判据 `GUIDE-VIS-5`。
 */

export interface GuidanceDisplayMessage {
  id?: string;
  content: string;
  role?: string;
  metadata?: Record<string, any> | null;
}

/** 注入模板的前缀（与 `GUIDANCE_MESSAGE_TEMPLATE` 保持同一形态；这里只认前缀，不复制全文） */
const TEMPLATE_PREFIX = "[Runtime guidance from the user]";
/** `<attachment>…</attachment>` 内联块（可跨行、可连续多块） */
const ATTACHMENT_BLOCK = /<attachment>[\s\S]*?<\/attachment>\s*/g;

/** 这条消息是不是「运行中追加」 */
export function isMidTurnGuidance(message: GuidanceDisplayMessage): boolean {
  if (!message) return false;
  if (message.metadata?.midTurnGuidance === true) return true;
  const id = typeof message.id === "string" ? message.id : "";
  if (id.startsWith("guidance-") && !id.startsWith("guidance-carryover-")) return true;
  return String(message.content ?? "").startsWith(TEMPLATE_PREFIX);
}

/**
 * 界面应当显示的正文。
 *
 * - 追加消息：剥掉附件块 + 模板框架 ⇒ 用户原文（`metadata.guidanceRaw` 优先，若有）；
 * - 普通消息：原样返回（不碰，避免误伤正文里真的写了 `<attachment>` 的例子）。
 */
export function guidanceDisplayMessage(message: GuidanceDisplayMessage): string {
  if (!isMidTurnGuidance(message)) return message.content;
  const raw = message.metadata?.guidanceRaw;
  if (typeof raw === "string") return raw;
  const withoutAttachments = String(message.content ?? "").replace(ATTACHMENT_BLOCK, "");
  const index = withoutAttachments.indexOf(TEMPLATE_PREFIX);
  if (index < 0) return withoutAttachments.trim();
  // 模板形态：前缀行 + 一句说明 + 空行 + 用户原文
  return withoutAttachments
    .slice(index)
    .replace(/^\[Runtime guidance from the user\]\n(?:[^\n]*\n)*?\n/, "")
    .trim();
}
