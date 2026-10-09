/**
 * 委派注入的**可辨认性**与**幂等**（第 194 波，GAP-LIST **O-56**）。
 *
 * ## 真机现场（用户报告，2026-10-09）
 *
 * 水位 222% ⇒ 点交接 ⇒ 新建「交接会话」⇒ 在该会话里聊了约几十条 ⇒ **刷新后**：
 * **最新一条是交接记录**，自己后面聊的内容在上面（被当成历史）。
 * 用户追加确认：那个会话名下**不止一条委派**，而且**每次委派都新建一个同名对话**。
 *
 * ## 定案的四环（每一环都在本文件里被钉住）
 *
 * | 环 | 事实 | 判据 |
 * | --- | --- | --- |
 * | ① | 注入的正文是一条**普通 user 消息**，前缀 `[DELEGATED TASK] `，而**没有任何组件认它** | `DELEG-LEG-1..3` |
 * | ② | 它的位置只由 `timestamp` 决定 ⇒ 第二条委派落到同一会话就排到**末尾** | `DELEG-LEG-4` |
 * | ③ | 同一条委派重复注入 = 往对话里**又追加一条一模一样的记录** | `DELEG-LEG-5`（同 id 覆盖） |
 * | ④ | 横幅交接每点一次就新建一个**同名**会话 ⇒ 肉眼分不出哪个是哪个 | `DELEG-TITLE-1/2` |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  DELEGATED_TASK_PREFIX,
  DELEGATED_MESSAGE_ID_PREFIX,
  delegatedMessageId,
  isDelegatedTaskMessage,
} from "../core/storage/session";

describe("第 194 波 · 委派注入的可辨认性（O-56）", () => {
  it("DELEG-LEG-1：注入消息的 id 带委派前缀，用户自己打的**不带**（反向对照）", () => {
    const injected = { id: delegatedMessageId("del-123-abc"), role: "user" as const, content: `${DELEGATED_TASK_PREFIX}【会话交接】…` };
    const human = { id: `user-1791266035380-abc123`, role: "user" as const, content: "把这个函数重命名一下" };

    expect(isDelegatedTaskMessage(injected), "委派注入的消息必须认得出来").toBe(true);
    expect(isDelegatedTaskMessage(human), "用户自己打的消息**不许**被误认成委派记录").toBe(false);
    expect(delegatedMessageId("del-1"), "id 必须能从前缀一眼看出是委派").toMatch(
      new RegExp(`^${DELEGATED_MESSAGE_ID_PREFIX}`),
    );
  });

  it("DELEG-LEG-2（反向对照）：id 缺失 / 非字符串 / 别的形状都不许判成委派", () => {
    for (const bad of [undefined, null, {}, { id: 123 }, { id: null }, { id: "user-1" }, { id: "delegated" }]) {
      expect(isDelegatedTaskMessage(bad as never), `不许把 ${JSON.stringify(bad)} 判成委派记录`).toBe(false);
    }
  });

  it("DELEG-LEG-3：界面**必须认得它**（不许再当普通用户气泡渲染）", () => {
    const bubble = readFileSync("src/components/MessageBubble.tsx", "utf8");
    expect(bubble, "MessageBubble 必须用同一个判定（否则又变成'没有任何组件认它'）").toContain("isDelegatedTaskMessage");
    expect(bubble, "要有独立的类名/标识，判据与样式都据此分辨").toContain("delegated-task");
    expect(bubble, "判据要能按 kind 断言（真机/组件判据都靠它）").toContain("data-message-kind");
    // 反向对照：用户自己的消息仍走原来的 user 分支（头像 + user 类名）
    expect(bubble, "用户消息的渲染不许被动过").toMatch(/isUser && !delegatedTask && <UserAvatar \/>/);
  });

  it("DELEG-LEG-4：注入点的 id 由**委派任务 id** 决定（同一条委派不可能再追加第二条记录）", () => {
    const executor = readFileSync("src/core/session/executor.ts", "utf8");
    expect(executor, "注入点必须用 delegatedMessageId(...) 生成 id").toContain("delegatedMessageId(delegationTaskId)");
    expect(executor, "普通消息仍用「时间戳 + 随机」的形态（两者一眼可分）").toMatch(/user-\$\{Date\.now\(\)\}-\$\{Math\.random/);
    // 反向对照：不许再用随机 id 注入委派（那正是"又追加一条"的成因）
    expect(executor, "委派注入不许再用随机 id").not.toMatch(/delegationTaskId\s*\?\s*`user-\$\{Date\.now\(\)\}/);
  });

  it("DELEG-LEG-5：同一条委派注入两次 —— 第二次是**同 id 覆盖**，不是多一条记录", async () => {
    const MessageStorage = await import("../core/storage/message");
    setStoragePort(createFakeStoragePort());
    const sid = "sess-o56-cover";
    const id = delegatedMessageId("del-o56-1");
    MessageStorage.createMessage({ id, role: "user", content: `${DELEGATED_TASK_PREFIX}第一次注入`, timestamp: 1000, status: "done" }, sid);
    MessageStorage.createMessage({ id, role: "user", content: `${DELEGATED_TASK_PREFIX}第二次注入（应覆盖）`, timestamp: 2000, status: "done" }, sid);
    const list = MessageStorage.listMessages(sid);
    expect(list.filter((m) => m.id === id).length, "同一条委派只许占**一条**记录").toBe(1);
    expect(list.find((m) => m.id === id)!.content, "内容是后写者胜（覆盖语义）").toContain("第二次注入");
  });
});

describe("第 194 波 · 新会话标题去重（O-56 的第四环）", () => {
  it("DELEG-TITLE-1：同名会话必须能分辨（第二个起加序号），第一个保持原名", async () => {
    const src = readFileSync("src/core/store.ts", "utf8");
    expect(src, "createSession 必须做标题去重（否则侧栏一堆同名「交接会话」）").toMatch(/finalTitle/);
    expect(src, "去重要用序号后缀").toMatch(/`\$\{baseTitle\} · \$\{n\}`/);
    // 与产品同一处：横幅交接仍传「交接会话」这个标题（去重是 createSession 的职责）
    const banner = readFileSync("src/components/WaterLevelBanner.tsx", "utf8");
    expect(banner).toContain('createSession(zh ? "交接会话"');
  });

  it("DELEG-TITLE-2（反向对照）：只有**同名**才加序号，不同名的一个字都不动", async () => {
    setStoragePort(createFakeStoragePort());
    const { useProjectStore } = await import("../core/store");
    const store = useProjectStore.getState();
    const a = store.createSession("交接会话");
    const b = store.createSession("交接会话");
    const c = store.createSession("别的名字");
    expect(a.title, "第一个用原名").toBe("交接会话");
    expect(b.title, "第二个必须能分辨出来").toBe("交接会话 · 2");
    expect(c.title, "不同名的不许被改").toBe("别的名字");
  });
});
