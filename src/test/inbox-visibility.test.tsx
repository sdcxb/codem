/**
 * 收件箱可见性 —— 用户报的真机 bug（第 72 轮）
 *
 * ## 现场（用户原话）
 *
 * > 任务交接后，左侧边栏的【任务管理】图标右上角会出现任务代办的数量提示，
 * > 点击进入任务管理，收件箱里没有信息，要等很久 10 几分钟甚至更久收件箱里才出现这 4 条信息。
 * > 且收件箱里的历史信息页看不到，重启应用后就没了。
 *
 * ## 真机实测（装机版，只读探针）
 *
 * ```text
 * 侧栏徽标： {"ariaLabel":"任务管理（4 条未读）","dotText":"4"}
 * 收件箱面板： {"emptyText":"尚未选择项目","hasDelegationWord":false}   ← 一条都没有
 * 侧栏项目： 无（当前没有打开任何项目）
 * ```
 * 查库确认那 4 条通知的 `project_id` 是 **NULL（全局通知）**：
 * 委派完成/失败、自动化、定时提醒都写成全局通知，**与项目无关**。
 *
 * ## 根因（两个口径打架）
 *
 * | 读法 | 边界 | 无项目时的结果 |
 * | --- | --- | --- |
 * | 侧栏徽标 `getUnreadCount()` | 不设边界 | 4（对） |
 * | 收件箱 `if (!pid) { setItems([]); return; }` | 无项目=清空 | 0（错） |
 *
 * 也就是"无项目"这件事被用**假值**表达了三件不同的事：不设边界 / 只要全局 / 干脆不显示。
 * 修法：把 `projectId` 写成显式三态（`undefined` 不设边界、`null` 只要全局、字符串 = 本项目 + 全局），
 * 界面层不再清空列表。
 *
 * ## 这个文件守什么
 *
 * ① 存储层三态语义（含"传 null 时**不许**碰到别的项目的通知"——那条曾经会把别人的未读一起标掉）；
 * ② 界面层：无项目 + 全局通知 ⇒ **必须看得见**（这条就是用户报的 bug，修之前是 0 条）；
 * ③ 界面层：无项目 + **别的项目**的通知 ⇒ 仍然不显示（P2-12 的承诺不许退回去）；
 * ④ 三处口径一致：侧栏徽标 / 概览卡 / 收件箱页签在同一个状态下必须给同一个数。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import React from "react";

const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";

/**
 * 用端口镜像预置 inbox 行（本仓既有夹具做法，见 `task-center-audit-fixes-2.test.tsx`）。
 * **必须走端口**：`domainReadMany` 读的是端口镜像，往别处塞行是塞不进去的
 * （那个文件里就踩过一次：改旧库 → 镜像里根本没有这一行）。
 */
async function seedInbox(rows: Array<Record<string, unknown>>) {
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  const port = createFakeStoragePort({ seed: { inbox: rows } });
  setStoragePort(port);
  port.domains.ensureLoaded("inbox");
  return port;
}

async function setProject(id: string | null) {
  const { useProjectStore } = await import("../core/store");
  await act(async () => {
    useProjectStore.setState({
      currentProject: id ? ({ id, name: id, path: "C:/x", createdAt: 0, lastAccessedAt: 0 } as any) : null,
    });
  });
}

function inboxRow(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    category: "delegation",
    title: "委派任务完成",
    body: null,
    source_type: "delegation",
    source_id: null,
    project_id: null,
    squad_id: null,
    issue_id: null,
    priority: "normal",
    read: 0,
    archived: 0,
    created_at: 100,
    ...over,
  };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("收件箱可见性：无项目时全局通知必须看得见（用户报的 bug）", () => {
  it("INBOX-1: 存储层三态 —— undefined 不设边界 / null 只要全局 / 字符串 = 本项目 + 全局", async () => {
    await seedInbox([
      inboxRow({ id: "g", project_id: null, created_at: 30 }),
      inboxRow({ id: "a", project_id: PROJECT_A, created_at: 20 }),
      inboxRow({ id: "b", project_id: PROJECT_B, created_at: 10 }),
    ]);
    const { InboxStorage } = await import("../core/inbox/inbox-storage");

    const all = InboxStorage.listAll().map((r) => r.id).sort();
    expect(all, "不设边界 = 全部（侧栏徽标的口径）").toEqual(["a", "b", "g"]);

    expect(InboxStorage.listAll({ projectId: null }).map((r) => r.id), "无项目 = 只要全局").toEqual(["g"]);
    expect(InboxStorage.listAll({ projectId: PROJECT_A }).map((r) => r.id).sort(), "本项目 + 全局").toEqual(["a", "g"]);
    expect(InboxStorage.listAll({ projectId: PROJECT_B }).map((r) => r.id).sort()).toEqual(["b", "g"]);
  });

  it("INBOX-2: 未读数同口径（这就是'徽标 4 / 列表 0'里那条 4）", async () => {
    await seedInbox([
      inboxRow({ id: "g1", project_id: null }),
      inboxRow({ id: "g2", project_id: null }),
      inboxRow({ id: "a1", project_id: PROJECT_A }),
      inboxRow({ id: "b1", project_id: PROJECT_B }),
      inboxRow({ id: "a-read", project_id: PROJECT_A, read: 1 }),
    ]);
    const { InboxStorage } = await import("../core/inbox/inbox-storage");

    expect(InboxStorage.getUnreadCount(), "侧栏徽标：不带边界").toBe(4);
    expect(InboxStorage.getUnreadCount(null), "无项目：只数全局").toBe(2);
    expect(InboxStorage.getUnreadCount(PROJECT_A), "本项目 + 全局").toBe(3);
  });

  it("INBOX-3: 无项目 + 全局通知 ⇒ 收件箱**必须列出来**（修之前这里是 0 条）", async () => {
    await seedInbox([
      inboxRow({ id: "g1", project_id: null, title: "委派任务完成: 全局那条" }),
      inboxRow({ id: "b1", project_id: PROJECT_B, title: "别的项目通知" }),
    ]);
    await setProject(null);
    const { InboxTab } = await import("../components/task-center/InboxTab");

    const { container } = render(<InboxTab />);
    const text = container.textContent || "";
    expect(text, "全局通知必须可见 —— 用户报的正是'徽标有 4 条、这里一条都没有'").toContain("委派任务完成: 全局那条");
    expect(text, "别的项目的通知仍然不该出现（P2-12）").not.toContain("别的项目通知");
    // 未读徽标与列表同口径（都是"全局 1 条"）
    expect(text).toContain("1");
  });

  it("INBOX-4: 无项目 + 只有别的项目的通知 ⇒ 列表空，但文案要如实说清'看到的是哪一类'", async () => {
    await seedInbox([inboxRow({ id: "b1", project_id: PROJECT_B, title: "别的项目通知" })]);
    await setProject(null);
    const { InboxTab } = await import("../components/task-center/InboxTab");

    const { container } = render(<InboxTab />);
    const text = container.textContent || "";
    expect(text).not.toContain("别的项目通知");
    expect(text).toMatch(/尚未选择项目/);
    expect(text, "不能暗示'没有通知' —— 要说明这里显示的是全局通知").toMatch(/全局通知/);
  });

  it("INBOX-5: 有项目时 本项目 + 全局 都在，别的项目不在", async () => {
    await seedInbox([
      inboxRow({ id: "a1", project_id: PROJECT_A, title: "A 的通知" }),
      inboxRow({ id: "g1", project_id: null, title: "全局通知" }),
      inboxRow({ id: "b1", project_id: PROJECT_B, title: "B 的通知" }),
    ]);
    await setProject(PROJECT_A);
    const { InboxTab } = await import("../components/task-center/InboxTab");

    const { container } = render(<InboxTab />);
    const text = container.textContent || "";
    expect(text).toContain("A 的通知");
    expect(text, "全局通知在任何项目下都该看得见").toContain("全局通知");
    expect(text).not.toContain("B 的通知");
  });

  it("INBOX-6: 「全部已读」在无项目时只清全局 —— 绝不许碰别的项目的通知", async () => {
    const port = await seedInbox([
      inboxRow({ id: "g1", project_id: null }),
      inboxRow({ id: "b1", project_id: PROJECT_B }),
    ]);
    const { InboxStorage } = await import("../core/inbox/inbox-storage");

    InboxStorage.markAllRead(null);

    const rows = (port as any).__table("inbox") as Array<{ id: string; read: number }>;
    expect(rows.find((r) => r.id === "g1")?.read, "全局的该被标记").toBe(1);
    expect(rows.find((r) => r.id === "b1")?.read, "别的项目的绝不能被顺手标掉").toBe(0);
  });

  /**
   * ⚠️ 真机核对时发现的第三种写法：**空串**。
   *
   * 委派链路里 `projectId` 是空串（全局会话没有项目），而 `params.projectId ?? null`
   * **不会**把空串换成 null（空串不是 null）⇒ 库里出现 `project_id = ""` 的行。
   * 只认 `null` 的判据会让这种行变成"幽灵"：徽标数得到、列表永远看不到。
   */
  it("INBOX-7: `project_id = ''` 也算全局通知（只认 null 会让这种行变成幽灵）", async () => {
    await seedInbox([
      inboxRow({ id: "empty", project_id: "", title: "空串项目的全局通知" }),
      inboxRow({ id: "null", project_id: null, title: "null 的全局通知" }),
      inboxRow({ id: "b", project_id: PROJECT_B, title: "B 的通知" }),
    ]);
    const { InboxStorage } = await import("../core/inbox/inbox-storage");

    expect(InboxStorage.listAll({ projectId: null }).map((r) => r.id).sort()).toEqual(["empty", "null"]);
    expect(InboxStorage.getUnreadCount(null)).toBe(2);
    expect(InboxStorage.getUnreadCount(PROJECT_A), "有项目时两者都算全局").toBe(2);

    await setProject(null);
    const { InboxTab } = await import("../components/task-center/InboxTab");
    const { container } = render(<InboxTab />);
    const text = container.textContent || "";
    expect(text).toContain("空串项目的全局通知");
    expect(text).toContain("null 的全局通知");
    expect(text).not.toContain("B 的通知");
  });

  /**
   * 同一个 bug 家族的第二个面：**委派页签**。
   * 从全局会话发起的交接，`task.projectId` 是空串 ⇒ 没有打开项目时整个页签是空的，
   * 而用户自己的那几个交接任务恰恰全属于这一类。
   */
  it("DELEG-1: 无项目时委派页签列出**全局委派**（而不是空列表 + 全零统计）", async () => {
    const { getDelegationOrchestrator } = await import("../core/session/orchestrator");
    const orch = getDelegationOrchestrator();
    // 直接构造两个任务：一个全局（projectId 空串）、一个别的项目
    (orch as any).tasks?.set?.("del-global", {
      id: "del-global", sourceSessionId: "s1", targetSessionId: "s2",
      task: "全局交接的任务", status: "completed", projectId: "", createdAt: 1, completedAt: 2,
    });
    (orch as any).tasks?.set?.("del-b", {
      id: "del-b", sourceSessionId: "s1", targetSessionId: "s3",
      task: "B 项目的任务", status: "running", projectId: PROJECT_B, createdAt: 3,
    });

    await setProject(null);
    const { DelegationTab } = await import("../components/task-center/DelegationTab");
    const { container } = render(<DelegationTab />);
    const text = container.textContent || "";
    expect(text, "全局委派必须看得见（它不属于任何项目，只能在无项目时看）").toContain("全局交接");
    expect(text, "别的项目的委派仍然不许冒出来（P2-12）").not.toContain("B 项目的任务");
  });

  /**
   * ## 第三个缺陷：重启后**委派历史根本补不回来**（真机实测）
   *
   * 装机版：库里 `delegation_tasks` 5 条，而「委派」页签 `0 总计 / 0 已完成`。
   * 机制（读代码 + 实测对齐）：
   *   1. 页签读的是**编排器内存**（`getAllDelegations()`），内存只在**构造函数**里补过一次；
   *   2. `delegation_tasks` 的域镜像**不在 `HOT_DOMAIN_TABLES` 预取清单里**；
   *   3. `domainReadMany` 对"镜像没就绪"的表返回 `undefined`，存储层按契约吞成 `[]`
   *      ⇒ 构造那一刻补到的是**空**，而**没有任何人会再试一次**（页签轮询的也是内存）。
   *
   * 修法：把补齐做成幂等 + 可重试（读路径上按窗口重试），并把该表加进预取清单。
   */
  it("DELEG-2: 构造时端口还没就绪 ⇒ 之后读一次必须把历史补回来（原实现是永久空）", async () => {
    const { setStoragePort, clearStoragePort } = await import("../core/storage/port");
    const { resetDelegationOrchestrator, getDelegationOrchestrator } = await import("../core/session/orchestrator");

    // ① 先在没有端口的情况下建编排器（模拟"构造函数跑在端口就绪之前"）
    clearStoragePort?.();
    resetDelegationOrchestrator();
    const orch = getDelegationOrchestrator();
    expect(orch.getAllDelegations(), "端口没就绪时确实读不到（这一步两种实现都一样）").toHaveLength(0);

    // ② 端口就绪 + 镜像里已经有历史
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const port = createFakeStoragePort({
      seed: {
        delegation_tasks: [
          {
            id: "del-restored-1", source_session_id: "s1", target_session_id: "s2",
            task: "重启前就完成的任务", status: "completed", result: "done", error: null,
            project_id: "", created_at: 100, started_at: 100, completed_at: 200,
          },
        ],
      },
    });
    setStoragePort(port);
    port.domains.ensureLoaded("delegation_tasks");

    // ③ 等过一个补齐窗口（重试间隔 250ms），再用**同一个**编排器读：
    //    必须自愈（不需要重建对象、不需要重启应用）
    await new Promise((r) => setTimeout(r, 300));
    const tasks = orch.getAllDelegations();
    expect(
      tasks.map((t) => t.id),
      "镜像就绪后历史必须自己补进来 —— 原来这里永远空着（用户报的'重启后委派页签空'）",
    ).toContain("del-restored-1");
  });

  /**
   * 预取清单漏表是"首次渲染读到空、之后没人重读"这类缺陷的**根源**：
   * 清单注释里写着"漏一张，那张表对应的面板就还是会掉进那个坑里"，
   * 而 `delegation_tasks` 恰好就是漏的那一张。
   */
  it("DELEG-3: 首屏预取清单必须包含委派任务表", async () => {
    const { HOT_DOMAIN_TABLES } = await import("../core/storage/bootstrap");
    expect(
      HOT_DOMAIN_TABLES,
      "漏掉 delegation_tasks ⇒ 委派页签与编排器的历史恢复都读不到（真机实测过）",
    ).toContain("delegation_tasks");
  });
});
