/**
 * `updateSession` **不得把镜像里陈旧的 `message_count` 写回引擎**（第 45 轮线协议审计 P1-2）。
 *
 * ## 缺陷长什么样
 *
 * `sessions.message_count` 在引擎侧是**由消息写入自动维护**的
 * （`repo.rs::bump_session_message_count`，注释写着"引擎是唯一写入者"）。
 * 而渲染侧的域镜像行是**启动时读进来的快照** —— 引擎后来增减的计数**从不回流**。
 *
 * `updateSession` 的实现是"读出整行 → 应用改动 → 整体 `crud.upsert {mode:replace}` 写回"，
 * 而 replace 语义**按传入列写**。于是：
 *
 *   · 用户重命名一次会话 → 引擎刚维护好的计数被镜像里那个陈旧值覆盖；
 *   · 12 小时一次的计数对账（`maintenance.ts`，写的是索引真值）随后再改回来；
 *   · 两个机制互相打架 —— 用户看到侧边栏数字自己跳。
 *
 * ## 为什么判据是"调用方有没有显式给 messageCount"
 *
 * 显式给的时候必须照写：`maintenance.ts` 的对账（索引真值）与
 * `NotebookWorkspace`（笔记本内嵌对话自己数）都是**有意**在写这一列。
 * 所以这条用例要同时钉住两件事 —— 不给就不写、给了就照写。改坏了任何一边都会红。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { __awaitPendingWrites } from "../core/storage/domain-store";
import * as SessionStorage from "../core/storage/session";

const PROJECT = "p-count";
const SESSION = "s-count";

function seed(): FakeStoragePort {
  const port = createFakeStoragePort();
  setStoragePort(port);
  SessionStorage.createSession({
    id: SESSION,
    projectId: PROJECT,
    title: "原标题",
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 0,
  });
  return port;
}

/** 直接看写穿命令里那一行的列（判据必须落在"发给引擎的列"上，不是内存表） */
function upsertRow(port: FakeStoragePort): Record<string, unknown> {
  const w = port.__writes().filter((x) => x.command === "crud.upsert").at(-1);
  expect(w, "必须有写穿命令").toBeTruthy();
  const rows = (w?.params as Record<string, unknown>)?.rows as Array<Record<string, unknown>>;
  return rows[0];
}

beforeEach(() => {
  setStoragePort(null);
});

describe("会话更新的列归属（engine-owned message_count 不许被镜像覆盖）", () => {
  it("SC-1: 只改标题时，写穿命令里**不得出现** `message_count`（引擎的值保持不动）", async () => {
    const port = seed();
    SessionStorage.updateSession(SESSION, { title: "新标题" });
    await __awaitPendingWrites(); // 第 71 轮：写序链会让同行的第二次写排队，断言前先等落地

    const row = upsertRow(port);
    expect(row.title, "标题必须被写").toBe("新标题");
    expect(
      Object.prototype.hasOwnProperty.call(row, "message_count"),
      "不给 messageCount 时**不许**带上这一列 —— 带上就等于用启动快照覆盖引擎刚刚维护好的计数（P1-2）",
    ).toBe(false);
    // 其余列仍然要写（replace 语义：不写就被清成 NULL 的那些）
    expect(row.id).toBe(SESSION);
    expect(row.project_id).toBe(PROJECT);
  });

  it("SC-2: 显式给 messageCount 时**必须照写**（对账/笔记本路径靠它）", async () => {
    const port = seed();
    SessionStorage.updateSession(SESSION, { messageCount: 7 });
    await __awaitPendingWrites();

    const row = upsertRow(port);
    expect(row.message_count, "显式给出的计数必须写穿（`maintenance.ts` 的对账与笔记本都走这条）").toBe(7);
  });

  it("SC-3: 同时改标题与计数 → 两列都写（不能因为 P1-2 的守卫把显式值吞掉）", async () => {
    const port = seed();
    SessionStorage.updateSession(SESSION, { title: "带计数", messageCount: 3 });
    await __awaitPendingWrites();

    const row = upsertRow(port);
    expect(row.title).toBe("带计数");
    expect(row.message_count).toBe(3);
  });
});
