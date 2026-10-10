/**
 * 第 198 波判据：**系统提醒（nudge）不许被当成用户说的话**。
 *
 * ## 用户真机直报
 *
 * > 对话完，重新打开对话，多了些以我为视角的信息，在我头像后面显示，就和我发的一样的格式，
 * > 如「[SYSTEM] 你在这一轮里改动了文件，但最后一次改动之后没有再运行验证…」
 *
 * ## 机制（为什么它会以用户身份出现）
 *
 * 收尾门把提醒写成 `createMessage({ id: "verify-nudge-<ts>", role: "user", … })` ——
 * **role 必须是 user**（否则模型不会把它当操作方指令回应），于是"这条是不是用户说的"这件事
 * 只能靠**另外的判据**回答；而界面各处当年只写了 `role === "user"` ⇒ 重开会话时提醒被渲染成
 * 用户自己的消息（右侧气泡、用户头衔、还带"编辑并重发"——点下去会把提醒当用户提问重发）。
 *
 * ## 判据清单
 *
 * - `SYSINJ-1`：八种提醒的 id 都认得出；真实用户 id 认不出（两个方向的对照）。
 * - `SYSINJ-2`：`MessageBubble` 渲染提醒 ⇒ **不是**用户气泡（无 `user` 类、无编辑入口），
 *   且正文仍然可见（不许把提醒藏起来 —— 它是"这一轮发生了什么"的证据）。
 * - `SYSINJ-3`（反向对照）：用户自己打的一模一样的文本 ⇒ 仍然是用户气泡。
 * - `SYSINJ-4`（棘轮 / 防复发）：扫 `agentic-loop.ts` 里所有 `role: "user"` 的 `createMessage`，
 *   其 id **必须**能被 `isSystemInjectedMessage` 认出来 —— "新加一种提醒但没人认它"当场变红。
 * - `SYSINJ-5`：轮次边界不吃提醒（`ChatPanel` 的"下一条 user = 新一轮"），
 *   总览与滚动条标记也不把它算成用户提问。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "../components/ui/tooltip";
import { createElement } from "react";
import {
  SYSTEM_INJECTED_MESSAGE_ID_PREFIXES,
  isDelegatedTaskMessage,
  isMachineInjectedMessage,
  isSystemInjectedMessage,
} from "../core/storage/session";
import { MessageBubble } from "../components/MessageBubble";
import type { Message } from "../store";

/** 真机上那一条（用户贴回来的原文，逐字） */
const REAL_NUDGE_TEXT =
  "[SYSTEM] 你在这一轮里**改动了文件，但最后一次改动之后没有再运行验证**（测试 / 构建 / 类型检查）。\n" +
  "注意：**之前跑过验证不算** —— 后来的改动会让那次验证失效…";

function msg(partial: Partial<Message> & { id: string; role: Message["role"]; content: string }): Message {
  return { timestamp: 1_700_000_000_000, status: "done", ...partial } as Message;
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("SYSINJ：系统提醒的辨认", () => {
  it("SYSINJ-1：八种提醒的 id 都认得出；用户自己打的消息认不出", () => {
    expect(SYSTEM_INJECTED_MESSAGE_ID_PREFIXES.length, "八种提醒 + 两种压缩标记（见 session.ts 的对照表）").toBe(10);
    for (const prefix of SYSTEM_INJECTED_MESSAGE_ID_PREFIXES) {
      expect(isSystemInjectedMessage({ id: `${prefix}1700000000000` }), `${prefix} 必须认得出`).toBe(true);
      expect(isMachineInjectedMessage({ id: `${prefix}1700000000000` })).toBe(true);
    }
    /* 反向对照：用户自己打的消息（`user-<ts>`）与别的机器消息各归各位 */
    expect(isSystemInjectedMessage({ id: "user-1700000000000" }), "用户自己打的不是系统提醒").toBe(false);
    expect(isMachineInjectedMessage({ id: "user-1700000000000" })).toBe(false);
    expect(isMachineInjectedMessage({ id: "delegated-task-1" }), "委派注入也算机器写的").toBe(true);
    expect(isSystemInjectedMessage({ id: "delegated-task-1" }), "但它不属于「系统提醒」这一族").toBe(false);
    expect(isDelegatedTaskMessage({ id: "delegated-task-1" })).toBe(true);
    /* 坏数据不许抛 */
    for (const bad of [null, undefined, {}, { id: 42 }, { id: "" }]) {
      expect(isSystemInjectedMessage(bad as never), `坏数据 ${JSON.stringify(bad)} 不许炸`).toBe(false);
      expect(isMachineInjectedMessage(bad as never)).toBe(false);
    }
  });

  /** 与既有 MessageBubble 判据同一套包装（气泡里用了 Tooltip） */
  const renderBubble = (m: Message) =>
    render(createElement(TooltipProvider, null, createElement(MessageBubble, { message: m, index: 0 } as never)));

  it("SYSINJ-2：提醒渲染成系统说明（不是用户气泡），正文仍然可见", () => {
    const { container } = renderBubble(
      msg({ id: "verify-nudge-1700000000000", role: "user", content: REAL_NUDGE_TEXT }),
    );
    const bubble = container.querySelector(".message");
    expect(bubble, "必须渲染出来（不许整条藏掉）").toBeTruthy();
    expect(bubble!.className.split(/\s+/), "不许带 user 类（用户真机看到的就是它）").not.toContain("user");
    expect(bubble!.className, "按系统说明渲染").toContain("system");
    expect(container.textContent ?? "", "提醒的内容要看得见（它是这一轮发生了什么的证据）").toContain("没有再运行验证");
    expect(
      container.querySelector(".user-msg-avatar, .message-avatar, .message-edit-btn, [data-action=edit]"),
      "不许出现用户头衔 / 编辑入口（点重发会把提醒当用户提问）",
    ).toBeNull();
  });

  it("SYSINJ-3（反向对照）：用户自己打的一模一样的文本 ⇒ 仍然是用户气泡", () => {
    const { container } = renderBubble(msg({ id: "user-1700000000000", role: "user", content: REAL_NUDGE_TEXT }));
    const bubble = container.querySelector(".message");
    expect(bubble!.className.split(/\s+/), "用户自己打的必须是 user 类（否则是把用户的话当机器说的）").toContain(
      "user",
    );
  });

  it("SYSINJ-4（棘轮）：agentic-loop 里每条 role=user 的 createMessage 的 id 都必须被认出来", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/core/llm/agentic-loop.ts"), "utf8");
    const missing: string[] = [];
    let scanned = 0;
    /**
     * ⚠️ 两个坑都踩过（第一版因此**漏扫**了 4 个注入点，而漏扫的棘轮会在新提醒没人认的时候照样绿）：
     * ① 块长度上限 400 太小（`verify-nudge` 那段十几行）⇒ 现在 4000，且下面断言扫到的条数；
     * ② 收尾逗号：有的调用写 `sessionId,` 有的写 `sessionId` ⇒ 正则要容 `,?`。
     */
    const callRe = /createMessage\(\s*\{([\s\S]{0,4000}?)\}\s*,\s*sessionId\s*,?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src))) {
      const block = m[1];
      if (!/role:\s*"user"/.test(block)) continue;
      scanned += 1;
      const idTpl = block.match(/id:\s*(`[^`]+`|"[^"]+")/);
      if (!idTpl) {
        /* 没有 id 字面量 ⇒ 只认两条已知的**生成器**（压缩标记 / 委派注入），别的一律报出来。
           窗口要往前看：`nextCompactionMarkerId("auto")` 在 createMessage 之前十几行（第 5877 vs 5890 行）——
           第一版只往后看 400 字符 ⇒ 把合法的压缩标记误报成"不认识"。 */
        const window = src.slice(Math.max(0, m.index - 1500), m.index + 400);
        if (/nextCompactionMarkerId\(|delegatedMessageId\(/.test(window)) continue;
        missing.push(`第 ${src.slice(0, m.index).split("\n").length} 行：id 是变量且不认识（人工确认它是不是机器注入）`);
        continue;
      }
      const concrete = idTpl[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "1700000000000");
      if (!isSystemInjectedMessage({ id: concrete })) missing.push(concrete);
    }
    expect(scanned, "至少要扫到 8 个注入点（少了说明扫描口径又漏了）").toBeGreaterThanOrEqual(8);
    expect(
      missing,
      "这些 role=user 的注入没有被 system-injected 判定认出来 ⇒ 重开会话时它们会渲染成用户自己说的话。" +
        "新加一种提醒时，把它加进 session.ts 的 SYSTEM_INJECTED_MESSAGE_ID_PREFIXES（并补进那张对照表）。",
    ).toEqual([]);
  });

  it("SYSINJ-5：轮次边界 / 总览 / 滚动条标记都不把提醒当用户提问", () => {
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    /* 这三处都是"把用户消息当轮次/标记/预览"的地方：只看 role==="user" 就会被提醒骗到 */
    for (const [rel, why] of [
      ["src/components/ChatPanel.tsx", "轮次边界（下一条 user = 新一轮）"],
      ["src/components/ConversationOverview.tsx", "总览的轮次与预览"],
      ["src/components/ScrollbarMarkers.tsx", "滚动条上的 User 标记"],
    ] as const) {
      const src = read(rel);
      expect(src, `${why}：必须用机器注入判定排除提醒`).toContain("isMachineInjectedMessage");
      /* 反向：不许再出现"只看 role === user"的裸判据（那正是缺陷成因） */
      const bare = [...src.matchAll(/role === "user"(?!\s*&&)/g)].length;
      expect(bare, `${why}：还有 ${bare} 处裸的 role === "user"（第 198 波修的就是它们）`).toBe(0);
    }
  });
});
