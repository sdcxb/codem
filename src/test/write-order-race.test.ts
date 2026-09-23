/**
 * WRITE-ORDER —— **同一行的两次写必须按调用顺序抵达引擎**（第 71 轮；用户真机报错）。
 *
 * ## 用户现场（跨会话委派时）
 *
 * ```text
 * 数据保存失败（telemetry.flush）：UNIQUE constraint failed: telemetry_events.id
 * 数据保存失败（delegation.createDelegationTask）：UNIQUE constraint failed: delegation_tasks.id
 * ```
 *
 * 两次都报"数据保存失败、重启后会丢"，但**行其实就在库里** —— 这是一对**假失败**。
 * 形态是同一个：同一行被写两次，而引擎侧 `crud.upsert` 的默认模式是**裸 INSERT**
 * （只有 `mode: "replace"` 才走"先 UPDATE、没有再 INSERT"）：
 *
 * ```text
 * ① createDelegationTask(task)                     → INSERT（在飞）
 * ② startTask → updateDelegationTaskStatus("replace") → UPDATE 0 行 → INSERT
 *        ── ② 先落库：行已存在
 *        ── ① 才落库：UNIQUE constraint failed ← 假失败
 * ```
 *
 * `telemetry.flush` 是同一形态的另一半：写穿（insert）与结账探测（replace）是**同一批行的两次写**。
 *
 * ## 本文件量什么
 *
 * 用一个**能制造"后发先至"的引擎桩**（insert 慢、replace 快）重现这个竞态：
 * 修复前第一条用例会红（报出 UNIQUE），且引擎收到的顺序是 `replace → insert`。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { domainWrite } from "../core/storage/domain-store";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { createDelegationTask, updateDelegationTaskStatus, getDelegationTask } from "../core/session/delegation-storage";
import type { DelegationTask } from "../core/session/types";

const TABLE = "delegation_tasks";
const TELEMETRY = "telemetry_events";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一行委派任务（列全给：`mode: "replace"` 是"只更新提供的列"，缺列会留旧值） */
const delegationRow = (status: string) => ({
  id: "del-race-1",
  source_session_id: "s-src",
  target_session_id: "s-dst",
  task: "把项目情况总结给新会话",
  status,
  result: null,
  error: null,
  project_id: "p1",
  created_at: 1,
  started_at: null,
  completed_at: null,
});

/**
 * 装一个"能让后发先至"的引擎桩：**insert 慢、replace 快**。
 *
 * 这正是真机上的形态 —— 两次写几乎同时发出，谁先落库由 IPC/引擎的调度决定；
 * 用固定延迟把竞态变成确定性的，测试才可复现。
 */
function installRacingEngine(port: FakeStoragePort, insertDelayMs = 25): { engineOrder: string[] } {
  const engineOrder: string[] = [];
  const real = port.data.execute.bind(port.data);
  port.data.execute = async (cmd: string, params: Record<string, unknown> = {}) => {
    if (cmd === "crud.upsert") {
      const mode = String(params.mode ?? "insert");
      engineOrder.push(mode);
      if (mode !== "replace") await sleep(insertDelayMs);
    }
    return real(cmd, params);
  };
  return { engineOrder };
}

let port: FakeStoragePort;
let out: { engineOrder: string[] };

beforeEach(() => {
  resetPersistFailures();
  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: "s-src", project_id: "p1", title: "源", created_at: 0, last_message_at: 0, message_count: 0 },
        { id: "s-dst", project_id: "p1", title: "目标", created_at: 0, last_message_at: 0, message_count: 0 },
      ],
    },
  });
  setStoragePort(port);
  out = installRacingEngine(port);
});

afterEach(() => {
  setStoragePort(null);
});

describe("WRITE-ORDER 同一行的两次写必须按调用顺序抵达引擎", () => {
  it("WRITE-ORDER-1：先 insert 后 replace 并发时**不许**报 UNIQUE（用户那条假失败）", async () => {
    // ① 创建（insert，慢）
    domainWrite(TABLE, [delegationRow("pending")], {
      scope: "delegation.createDelegationTask",
      note: "委派任务未保存",
    });
    // ② 立刻改成 running（replace，快）—— 真机上这就是 startTask 那一步
    domainWrite(TABLE, [delegationRow("running")], {
      mode: "replace",
      scope: "delegation.updateDelegationTaskStatus",
      note: "委派任务状态未更新",
    });
    await sleep(120);

    const failures = getPersistFailures();
    expect(
      failures.map((f) => `${f.area}: ${f.lastMessage}`),
      "同一行的两次写不许互相撞主键 —— 撞了就会向用户报一次「数据保存失败」，而数据其实没丢",
    ).toEqual([]);
  });

  it("WRITE-ORDER-2：引擎收到的顺序必须与调用顺序一致（insert 先、replace 后）", async () => {
    domainWrite(TABLE, [delegationRow("pending")], { scope: "delegation.createDelegationTask", note: "x" });
    domainWrite(TABLE, [delegationRow("running")], {
      mode: "replace",
      scope: "delegation.updateDelegationTaskStatus",
      note: "y",
    });
    await sleep(120);
    expect(out.engineOrder, "写序被颠倒 ⇒ 非幂等的 insert 会撞主键").toEqual(["insert", "replace"]);
  });

  it("WRITE-ORDER-3：委派任务的 create → startTask 真实路径（用户场景）", async () => {
    const task: DelegationTask = {
      id: "del-race-1",
      sourceSessionId: "s-src",
      targetSessionId: "s-dst",
      task: "把项目情况总结给新会话",
      status: "pending",
      projectId: "p1",
      createdAt: 1,
    };
    createDelegationTask(task); // insert
    updateDelegationTaskStatus(task.id, "running", { startedAt: 2 }); // replace
    await sleep(120);

    expect(
      getPersistFailures().map((f) => f.area),
      "这条路径就是用户真机上报的那一条；不许再报写盘失败",
    ).toEqual([]);
    expect(getDelegationTask(task.id)?.status, "最终状态必须是 running（后写者胜）").toBe("running");
  });

  it("WRITE-ORDER-4：遥测同一批行重复写（写穿 + 结账探测）不许撞主键", async () => {
    const rows = [
      { id: "tel-1", session_id: "s-src", event_name: "e1", event_data: "{}", timestamp: 1 },
      { id: "tel-2", session_id: "s-src", event_name: "e2", event_data: "{}", timestamp: 2 },
    ];
    // 写穿（已改成 replace）与探测（replace）都会重复写同一批行
    for (const row of rows) {
      domainWrite(TELEMETRY, [row], { mode: "replace", scope: "telemetry.flush", note: "n" });
    }
    await sleep(60);
    expect(getPersistFailures().map((f) => f.lastMessage)).toEqual([]);
  });

  it("WRITE-ORDER-5（反向守卫）：**不同行**的写不许互相排队（链是按 (表,主键) 分的）", async () => {
    // 行的 insert 慢 25ms；另一行的 insert 应当在它落库之前就发出
    const a = { ...delegationRow("pending"), id: "del-a" };
    const b = { ...delegationRow("pending"), id: "del-b" };
    domainWrite(TABLE, [a], { scope: "s", note: "n" });
    const started = Date.now();
    domainWrite(TABLE, [b], { scope: "s", note: "n" });
    // 第二行的命令**当场发出**（不等待第一行），所以这里同步就该看到两条 insert 都进了引擎
    expect(out.engineOrder.length, "不同行之间不该串行等待").toBe(2);
    expect(Date.now() - started, "第二行不该等第一行的 25ms").toBeLessThan(20);
    await sleep(80);
    expect(getPersistFailures()).toEqual([]);
  });
});
