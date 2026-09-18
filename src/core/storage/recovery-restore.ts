/**
 * 「损坏恢复」时把**从坏库里抢救出来的项目 / 会话归属**还原回索引。
 *
 * ## 为什么需要这个文件（第 47 轮补：一个"零缺口"清单上的真缺口）
 *
 * 损坏恢复的链路是完整的、而且每一环都有注释交代：
 * `Engine::open_with_recovery` 把坏文件**改名备份** → 建空库 →
 * `health.recovered` 报给渲染侧 → 渲染侧写"索引需要重建"标记 + 提示用户 →
 * 维护时 `rebuildIndexFromSessionLogs()` 从**权威 JSONL 日志**把索引重建回来。
 *
 * 但那条链路**还原不了"会话属于哪个项目"**：
 * - 权威 JSONL 日志记的是"消息"，没有会话归属这一列
 *   （`session-log-bridge.ts` 的注释自己写着：`project_id` 只能从 `sessions` 域镜像取）；
 * - 而重建发生在**空库**上 —— `sessions` 表当时是空的；
 * - 于是 `projectOf` 取不到任何东西 → **所有复活的会话 `project_id` 落成 `""`**，
 *   而 `""` 在引擎里是"**全局项目**"的缺省语义。
 *
 * 真机后果：用户的会话全部掉进"全局对话"，而他明明有项目。仓库里那句告警写着
 * "这个数字应当长期为 0"（`withoutProject`），而损坏恢复这条路让它**必然非 0**。
 *
 * ## 数据从哪来
 *
 * 唯一来源是那份**坏文件的备份**（`.corrupt-<ts>`）。引擎在 `open_with_recovery` 里
 * 只读打开它、把 `projects` 与 `sessions.id/project_id` 抄成旁路文件
 * （`<db>.recovered-projects.json`），并附在 `health.recovered_projects` 上。
 *
 * ## 顺序为什么必须"先项目、后会话"
 *
 * `sessions.project_id` 有**外键**指向 `projects(id)`，而引擎打开时
 * `PRAGMA foreign_keys=ON`。项目行不先写进去，会话行会因外键被拒
 * （这正是本项目 1.16.66 那次真机事故的同类形态）。所以两步顺序不能换。
 *
 * ## 三态与失败处置
 *
 * - 没有 `recovered_projects`（库没损坏过 / 坏到读不出 `sessions` 表）→ 静默返回 0 条目，
 *   **不是错误**；
 * - 写入失败 → 如实 `reportPersistFailure`，但**不影响**恢复本身
 *   （消息仍会从 JSONL 重建，只是归属回到全局项目，与修之前的行为一致）；
 * - 幂等：全部走 upsert，重复调用不会产生重复行。
 */

import { reportPersistFailure } from "./persist-failure";

/** `health.recovered_projects` 的形状（由 Rust `storage_health` 提供） */
export interface RecoveredProjectsPayload {
  projects?: Array<{
    id?: unknown;
    name?: unknown;
    path?: unknown;
    description?: unknown;
    pinned?: unknown;
    created_at?: unknown;
    last_accessed_at?: unknown;
  }>;
  sessions?: Array<{ id?: unknown; project_id?: unknown }>;
}

export interface RestoreRecoveredResult {
  /** 写回的项目行数 */
  projects: number;
  /** 写回归属的会话行数 */
  sessions: number;
  /** 因为外键/形状问题**没写成功**的会话行数（如实计数，不静默） */
  skipped: number;
}

/**
 * 把抢救出来的行还原进索引。
 *
 * @param payload `health.recovered_projects`（缺省/形状不对 → 什么都不做）
 * @returns 写回的行数（供调用方记日志与上报）
 */
export async function restoreRecoveredProjects(
  payload: unknown,
): Promise<RestoreRecoveredResult> {
  const out: RestoreRecoveredResult = { projects: 0, sessions: 0, skipped: 0 };
  if (!payload || typeof payload !== "object") return out;
  const p = payload as RecoveredProjectsPayload;

  const projectRows = Array.isArray(p.projects) ? p.projects : [];
  const sessionRows = Array.isArray(p.sessions) ? p.sessions : [];
  if (projectRows.length === 0 && sessionRows.length === 0) return out;

  try {
    const { domainWrite, reportWriteNotAccepted } = await import("./domain-store");

    /*
     * ① 先项目（`sessions.project_id` 的外键目标）。缺 name/path 的行**照样写** ——
     * `name` / `path` 是 NOT NULL，用空串补齐：一个名字空的项目行**仍然能承载归属**，
     * 而丢掉它会让下面所有会话行被外键拒（那才是真正的损失）。
     */
    const projectWire = projectRows
      .map((r) => {
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) return null;
        return {
          id,
          name: typeof r.name === "string" ? r.name : "",
          path: typeof r.path === "string" ? r.path : "",
          description: typeof r.description === "string" ? r.description : null,
          pinned: Number(r.pinned ?? 0) === 1 ? 1 : 0,
          created_at: Number(r.created_at ?? 0) || Date.now(),
          // `last_accessed_at` 是 NOT NULL（schema）：缺省用 created_at，不用 0
          last_accessed_at: Number(r.last_accessed_at ?? 0) || Number(r.created_at ?? 0) || Date.now(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (projectWire.length > 0) {
      /**
       * ## 第 55 轮：**这里原来是一个静默丢弃点**
       *
       * `domainWrite` 的返回值语义是"**端口有没有接手这次写**"（`domain-store.ts:711-721`）：
       * `true` = 镜像已就绪当场写穿（失败会自己上报）或正在加载已入队；
       * `false` = 没接手（端口未注册 / 该表**永不就绪**：超上限被拒或加载失败）。
       *
       * 原实现只写 `if (ok) out.projects = …`，**false 分支什么都不做** ——
       * 于是"抢救出来的项目一行都没写回去"这件事既不上报、也不记录：
       * 后果（下面 `note` 里写着的那句"会话归属会因此落到全局项目"）
       * 只存在于源码里，用户与排查者都看不到。
       *
       * ⚠️ 为什么这里**确实可达**（不是理论问题）：这个写入点操作的是 `projects` 表，
       * 而上面判"能不能写"用的是 `sessions` 的读结果 —— **两张表的就绪状态互相独立**。
       * `projects` 的镜像"永不就绪"（真机形态：`crud.list` 被拒或加载失败）时，
       * `sessions` 那边照样读得到，于是流程会一路走到这里并静默丢掉全部项目行。
       *
       * 修法沿用本仓库既有的两行形态（见 `createSession` / `updateSession`）：
       * 没接手就 `reportWriteNotAccepted(scope, note)` —— 上报 + 不回退。
       */
      const accepted = domainWrite("projects", projectWire, {
        scope: "storage.recoveryRestore.projects",
        note: "抢救出来的项目未写回（会话归属会因此落到全局项目）",
      });
      if (accepted) out.projects = projectWire.length;
      else {
        reportWriteNotAccepted(
          "storage.recoveryRestore.projects",
          `抢救出来的 ${projectWire.length} 个项目未写回`,
          {
            // 说清**后果**（这一句才是用户看得见的那条提示的内容）
            consequence:
              `抢救出来的 ${projectWire.length} 个项目没写回索引：这些会话会落到「全局项目」而不是原来的项目` +
              `（历史消息不受影响，它们由会话日志重建）`,
          },
        );
      }
    }

    /*
     * ② 再会话归属。**只更新已存在行的 `project_id`**，不新建会话行 ——
     * 会话行由重建路径（`messages.rebuild_index`）按"日志里真的有消息"来建，
     * 这里若抢先建空会话行，会造出没有消息的幽灵会话。
     */
    const { domainReadMany } = await import("./domain-store");
    const existing = domainReadMany<Record<string, unknown>>("sessions", (r) => r);
    if (!existing) {
      console.warn(
        "[Recovery] sessions 镜像未就绪 → 本次不写会话归属（抢救到的行先留在 health 里）",
      );
      return out;
    }
    const known = new Set(existing.map((r) => String(r.id ?? "")));
    const updates = sessionRows
      .map((r) => {
        const id = typeof r.id === "string" ? r.id : "";
        const pid = typeof r.project_id === "string" ? r.project_id : "";
        if (!id || !known.has(id)) return null;
        // 只改归属，且只改**当前确实为空**的行 —— 不覆盖用户已经设定好的归属
        const cur = String(existing.find((e) => String(e.id ?? "") === id)?.project_id ?? "");
        if (cur !== "") return null;
        return { id, project_id: pid };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    for (const u of updates) {
      const ok = domainWrite("sessions", [u], {
        scope: "storage.recoveryRestore.sessionProject",
        note: "抢救出来的会话归属未写回",
      });
      if (ok) out.sessions += 1;
      else out.skipped += 1;
    }
    /**
     * 第 55 轮：逐条会话写入的拒绝也要**能被看到**（原来只累加 `out.skipped`，
     * 而调用方只在"有成功行"时才打日志 —— 全是失败时一行日志都没有）。
     *
     * 这一条在真机上**不可达**（能读到 `sessions` 镜像就说明它已就绪，
     * 同一张表的写入必然被接手），所以它是一条防御性上报；写成**聚合成一条**，
     * 避免 N 条失败刷屏。
     */
    if (out.skipped > 0) {
      reportWriteNotAccepted(
        "storage.recoveryRestore.sessionProject",
        `${out.skipped} 个会话的归属未写回（这些会话会落到全局项目）`,
      );
    }
  } catch (e) {
    reportPersistFailure(
      "storage.recoveryRestore",
      e,
      "损坏恢复的项目/会话归属未还原（消息仍会从权威日志重建，归属会落到全局项目）",
    );
  }
  return out;
}
