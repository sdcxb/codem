/**
 * 「损坏恢复」时抢救出的项目 / 会话归属必须真的还原（第 47 轮补）
 *
 * ## 这一组用例守的是一个**真缺口**（不是假想）
 *
 * 损坏恢复链路本身是完整的、每一环都有注释交代：坏文件改名备份 → 建空库 →
 * `health.recovered` → 写"索引需要重建"标记 → 维护从**权威 JSONL 日志**重建索引。
 *
 * 但它**还原不了"会话属于哪个项目"**：
 * - 权威 JSONL 日志记的是消息，没有会话归属这一列；
 * - 重建发生在**空库**上，`sessions` 表当时是空的；
 * - 于是 `rebuildIndexFromSessionLogs` 的 `projectOf` 取不到东西
 *   → **所有复活的会话 `project_id` 落成 `""`**，而 `""` 在引擎里是"全局项目"。
 *
 * `session-log-bridge.ts` 里那句告警自己写着"这个数字应当长期为 0"
 * （`withoutProject`），而损坏恢复这条路让它**必然非 0**。
 *
 * 修法：引擎在恢复时只读打开那份坏文件备份，把 `projects` 与
 * `sessions.id/project_id` 抄成旁路文件并附在 `health.recovered_projects` 上；
 * 渲染侧在**写重建标记之前**把它落回索引（顺序不能反，见下）。
 *
 * ## 用例覆盖的三个关键点
 *
 * | 用例 | 守什么 |
 * | --- | --- |
 * | `REC-1` | 项目先写、会话归属后写（外键顺序），且归属真的落到库里 |
 * | `REC-2` | **不覆盖**用户已有的归属（只补 `project_id` 为空的行） |
 * | `REC-3` | 没有抢救数据 / 形状不对 → 什么都不做，**不报错**（库坏到读不出表是可能的） |
 * | `REC-4` | `sessions` 镜像未就绪 → 不写归属（也不抛），消息仍会从日志重建 |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

type Row = Record<string, unknown>;

let port: FakeStoragePort;

const sessionRow = (id: string, projectId: string): Row => ({
  id,
  project_id: projectId,
  title: id,
  model: null,
  created_at: 1,
  last_message_at: 2,
  message_count: 0,
  pinned: 0,
});

const projectRow = (id: string, name: string) => ({
  id,
  name,
  path: `C:\\${name}`,
  description: null,
  pinned: 0,
  created_at: 1,
  last_accessed_at: 2,
});

async function installPort(seed: Record<string, Row[]> = {}) {
  port = createFakeStoragePort({ seed });
  await port.config.warmup();
  setStoragePort(port);
  return port;
}

beforeEach(() => {
  setStoragePort(null);
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("损坏恢复：抢救出来的项目归属必须还原（REC）", () => {
  it("REC-1: 项目先写、会话归属后写 —— 归属真的落到库里（外键顺序不能反）", async () => {
    const { restoreRecoveredProjects } = await import("../core/storage/recovery-restore");
    // 空库形态：损坏恢复刚建出来的新库，没有任何会话行
    await installPort({ projects: [], sessions: [] });

    const result = await restoreRecoveredProjects({
      projects: [projectRow("p1", "mimo-gui")],
      // 会话行**尚未被重建创建** → 这一条不该被写（不造幽灵会话），见 REC-1b
      sessions: [{ id: "s1", project_id: "p1" }],
    });

    expect(result.projects, "项目必须写回去（它是外键目标）").toBe(1);
    const projects = port.__table("projects");
    expect(projects.find((r) => r.id === "p1")?.name, "项目名要逐字带回").toBe("mimo-gui");
    expect(
      result.sessions,
      "会话行还不存在 → 归属这次不写（等重建把会话行建出来）",
    ).toBe(0);
  });

  it("REC-1b: 会话行已存在且归属为空 → 补上抢救到的归属", async () => {
    const { restoreRecoveredProjects } = await import("../core/storage/recovery-restore");
    // 重建已经跑过一轮：会话行在，但 project_id 被落成了 ""（这正是本缺陷的真机形态）
    await installPort({
      projects: [],
      sessions: [sessionRow("s1", ""), sessionRow("s2", "")],
    });

    const result = await restoreRecoveredProjects({
      projects: [projectRow("p1", "mimo-gui")],
      sessions: [
        { id: "s1", project_id: "p1" },
        { id: "s2", project_id: "p1" },
      ],
    });

    expect(result.projects).toBe(1);
    expect(result.sessions, "两条归属都要补上").toBe(2);
    const sessions = port.__table("sessions");
    expect(sessions.find((r) => r.id === "s1")?.project_id, "s1 不再落到全局项目").toBe("p1");
    expect(sessions.find((r) => r.id === "s2")?.project_id).toBe("p1");
  });

  it("REC-2: **不覆盖**用户已经设好的归属（只补空的那部分）", async () => {
    const { restoreRecoveredProjects } = await import("../core/storage/recovery-restore");
    await installPort({
      projects: [projectRow("p1", "A"), projectRow("p2", "B")],
      sessions: [sessionRow("s1", "p2")], // 用户已经把它放在 p2
    });

    const result = await restoreRecoveredProjects({
      projects: [projectRow("p1", "A")],
      sessions: [{ id: "s1", project_id: "p1" }], // 抢救数据说是 p1（旧值）
    });

    expect(result.sessions, "已有归属的行不动").toBe(0);
    expect(
      port.__table("sessions").find((r) => r.id === "s1")?.project_id,
      "绝不能用旧备份覆盖用户当前的归属 —— 那比不还原更糟",
    ).toBe("p2");
  });

  it("REC-3: 没有抢救数据 / 形状不对 → 什么都不做且**不报错**", async () => {
    const { restoreRecoveredProjects } = await import("../core/storage/recovery-restore");
    await installPort({ projects: [], sessions: [sessionRow("s1", "")] });

    // 库坏到读不出 sessions 表时就没有这个字段；形状也可能被改坏
    for (const payload of [undefined, null, {}, { projects: "oops" }, { sessions: 42 }, []]) {
      const r = await restoreRecoveredProjects(payload);
      expect(r, `payload=${JSON.stringify(payload)} 必须安静地什么都不做`).toEqual({
        projects: 0,
        sessions: 0,
        skipped: 0,
      });
    }
    expect(port.__table("projects").length, "库里不该多出任何行").toBe(0);
  });

  it("REC-4: sessions 镜像未就绪 → 归属不写（也不抛），项目照写", async () => {
    const { restoreRecoveredProjects } = await import("../core/storage/recovery-restore");
    const p = createFakeStoragePort({
      seed: { projects: [], sessions: [] },
      neverReady: ["sessions"],
    });
    await p.config.warmup();
    setStoragePort(p);

    let result: Awaited<ReturnType<typeof restoreRecoveredProjects>> | null = null;
    await expect(
      (async () => {
        result = await restoreRecoveredProjects({
          projects: [projectRow("p1", "mimo-gui")],
          sessions: [{ id: "s1", project_id: "p1" }],
        });
      })(),
      "镜像未就绪不是错误，不许抛",
    ).resolves.toBeUndefined();

    expect(result!.projects, "项目那一半仍然要写（它不依赖 sessions 镜像）").toBe(1);
    expect(result!.sessions, "sessions 读不到 → 归属这次不写，等下次（不许猜）").toBe(0);
  });

  it("REC-5: 项目名/路径缺失的行**照样写**（保住外键目标比保住名字重要）", async () => {
    const { restoreRecoveredProjects } = await import("../core/storage/recovery-restore");
    await installPort({ projects: [], sessions: [sessionRow("s1", "")] });

    const result = await restoreRecoveredProjects({
      // 坏库里 `projects` 表只读出了一部分列（页级损坏的常见形态）
      projects: [{ id: "p1" } as any],
      sessions: [{ id: "s1", project_id: "p1" }],
    });

    expect(result.projects, "缺 name/path 也要写（NOT NULL 用空串补）").toBe(1);
    const row = port.__table("projects").find((r) => r.id === "p1");
    expect(row, "行必须在 —— 否则下面所有会话行会被外键拒").toBeTruthy();
    expect(row?.name).toBe("");
    expect(result.sessions, "归属因此得以写回").toBe(1);
  });
});
