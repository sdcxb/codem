/**
 * 启动自检：用户内容"无故消失"时自动从旧库恢复（第 32 轮）
 *
 * ## 为什么需要它（而不是继续追调用栈）
 *
 * 第 31–32 轮的事故形态：迁移对账通过后，新库的 `messages / sessions /
 * session_events / tool_calls` 被一次性清掉，而渲染侧**所有**审计点都没有记录到删除
 * （端口三层 + domain-store 全部 5 个写穿点 + 删除类写操作的控制台记录）。
 * 也就是说，删除来自某条尚未被插桩的路径，而**追查它已经花了两轮真机实验**。
 *
 * 这段时间里用户看到的是"项目在、会话和消息全空"。比起继续猜，
 * 更该先做到的是：**无论谁删的，用户都不该真的丢数据**。
 *
 * ## 判据（刻意保守，只救"明显异常"）
 *
 * 每次启动记录一次"健康水位"（消息数 / 会话数）。下次启动时：
 * - 现在还有消息 → 只更新水位，什么都不做；
 * - 现在**一条消息都没有**，而上一次水位有明显数量（≥ 阈值）→ 判定为**异常丢失**；
 * - 且**旧库确实还有内容**（只读 `dry_run` 探测）→ 允许用旧库恢复一次。
 *
 * 三条同时成立才动手。少任何一条都只记录、不覆盖 —— 覆盖是单向操作，
 * 宁可让用户看到空列表并留下明确告警，也不能冒"把用户自己删空的状态又灌回去"的风险。
 *
 * ## 为什么放在"每次启动"而不是"异常发生时"
 *
 * 异常发生的时刻正是数据库状态最不可信的时刻（删除可能与写事务交错）。
 * 启动时是状态最干净、最容易判断的窗口 —— 这也是本项目"日志权威、索引可重建"
 * 那条分层原则的自然延伸。
 */

import { getStoragePort, hasStoragePort } from "./port";
import { reportActionFailure } from "./persist-failure";

/** 水位存在 `settings` 里（配置面，几行数据，读起来最便宜） */
const MARKER_KEY = "codem-storage-content-watermark";

/** 低于这个数量不算"明显丢失"（避免把"用户本来就只聊了两句"误判成事故） */
const SUSPICIOUS_MIN_MESSAGES = 50;

interface Watermark {
  at: number;
  messages: number;
  sessions: number;
}

export interface SelfHealResult {
  kind: "ok" | "suspicious" | "restored" | "unavailable";
  /** 上一次记录的水位（没有则为 null） */
  previous?: Watermark;
  /** 现在实际有多少 */
  current?: Watermark;
  /** 恢复时搬运的行数 */
  restoredRows?: number;
  reason?: string;
}

async function countRows(table: string): Promise<number | null> {
  try {
    const port = getStoragePort();
    const page = await port.data.query<{ id: string }>("crud.list", { table, limit: 1 });
    // 只取 1 行不够判断"有多少" —— 用 crud.count 更准，但它走 execute 被压成 {written}，
    // 所以这里退一步：用 query + 大 limit 会太重，改用仓储的 counts 命令语义。
    void page;
    return null;
  } catch {
    return null;
  }
}
void countRows;

/** 用 `crud.count` 读真实行数（结构化返回，不走会被压平的 execute） */
async function realCount(table: string): Promise<number | null> {
  try {
    const port = getStoragePort();
    // `crud.count` 是查询型命令：`query` 会把它当"取列表"处理，所以这里用 command 拿结构化结果
    const probe = port.data as unknown as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    if (probe.command) {
      const r = await probe.command<{ count?: number }>("crud.count", { table });
      if (typeof r?.count === "number") return r.count;
    }
    return null;
  } catch {
    return null;
  }
}

function readWatermark(settings: Array<{ key: string; value: string }>): Watermark | null {
  const raw = settings.find((s) => s.key === MARKER_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Watermark;
    if (typeof parsed?.messages !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeWatermark(w: Watermark): Promise<unknown> {
  const port = getStoragePort();
  return port.data.execute("settings.set", { key: MARKER_KEY, value: JSON.stringify(w) });
}

/**
 * 运行期守护：**同一进程内**发现内容归零就立刻恢复（第 37 轮）。
 *
 * ## 为什么不能只在启动时自检
 *
 * 真机实测的完整时间线（文件级取证 + SQLite 审计对齐）：
 * 应用启动后 `messages.count` 读到 **277**（该会话全在）、`sessions.list` 读到 **3**；
 * 随后**点开一个会话**，WAL 在 1 秒内从 28KB 涨到 1.75MB，紧接着
 * `messages=0 / sessions=1` —— 也就是说，**数据是在使用过程中消失的**，
 * 而启动自检只能覆盖"启动那一刻"，中间这段时间用户是裸奔的。
 *
 * 所以需要第二个触发点：**打开会话前**做一次廉价核对（一条 `crud.count`），
 * 发现"内容归零而水位很高"就立刻恢复，让用户根本看不到空列表。
 *
 * 判据与启动自检完全一致（同一水位、同一阈值、同样要求旧库确有内容），
 * 并带一个"进行中"闩锁避免并发恢复。
 */
let healInFlight: Promise<SelfHealResult> | null = null;

export function guardContentBeforeSessionOpen(legacyPath: string | null): Promise<SelfHealResult> {
  if (healInFlight) return healInFlight;
  healInFlight = verifyUserContentOrRestore(legacyPath, { quietWhenHealthy: true }).finally(() => {
    healInFlight = null;
  });
  return healInFlight;
}

/**
 * 启动自检入口。**永不抛**（自检失败不该影响启动）。
 *
 * @param legacyPath 旧库路径（恢复源）
 * @param opts.quietWhenHealthy 健康时不写水位（运行期高频调用用，避免每开一个会话都写一次 settings）
 */
export async function verifyUserContentOrRestore(
  legacyPath: string | null,
  opts: { quietWhenHealthy?: boolean } = {},
): Promise<SelfHealResult> {
  if (!hasStoragePort()) return { kind: "unavailable", reason: "端口未注册" };
  try {
    const port = getStoragePort();
    if (port.kind !== "rust") return { kind: "unavailable", reason: `引擎为 ${port.kind}` };

    const settingsPage = await port.data.query<{ key: string; value: string }>("crud.list", {
      table: "settings",
      limit: 2000,
    });
    const previous = readWatermark(settingsPage.items ?? []);

    const messages = (await realCount("messages")) ?? 0;
    const sessions = (await realCount("sessions")) ?? 0;
    const current: Watermark = { at: Date.now(), messages, sessions };

    // 只要有消息，就认为内容健康 —— 只更新水位（运行期核对时跳过，省一次写）
    if (messages > 0) {
      if (!opts.quietWhenHealthy) await writeWatermark(current);
      return { kind: "ok", previous: previous ?? undefined, current };
    }

    // 一条消息都没有：只有"上一次明明有很多"才算异常
    const suspicious = (previous?.messages ?? 0) >= SUSPICIOUS_MIN_MESSAGES;
    if (!suspicious) {
      await writeWatermark(current);
      return { kind: "ok", previous: previous ?? undefined, current };
    }

    // 异常：先看旧库有没有可恢复的内容（只读探测，不写）
    const legacyHas = await legacyHasMessages(port, legacyPath);
    if (!legacyHas) {
      reportActionFailure(
        "storage.selfHeal",
        new Error("用户内容疑似丢失，但旧库没有可恢复的内容"),
        `查询索引里一条消息都没有（上次水位 ${previous?.messages} 条），旧库也没有内容 —— 需要人工确认`,
      );
      await writeWatermark(current);
      return { kind: "suspicious", previous: previous ?? undefined, current, reason: "旧库无可恢复内容" };
    }

    /*
     * 三条判据都成立 → 允许恢复一次（replace 语义，内容是旧库那份权威副本）。
     *
     * ⚠️ 这里**不能用 `reportActionFailure`**：它的语义是"某功能本次没有生效"，
     * 而这里恰恰相反 —— 自愈**成功**了（实测恢复 3990 行）。用错通道会打出
     * "该功能本次没有生效"这种与事实相反的告警（真机日志里就是这么出现的）。
     * 数据丢失这件事本身要留痕，但通道应该是"异常已处理"而不是"功能失败"。
     */
    console.warn(
      `[Storage] 自检发现用户内容无故消失（上次 ${previous?.messages} 条消息，现在 0 条）—— 正在从旧库恢复`,
    );
    const probe = port.data as unknown as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    const res = await probe.command?.<{ rows?: number }>("migration.auto", {
      legacy_path: legacyPath,
    });
    const after = (await realCount("messages")) ?? 0;
    await writeWatermark({ at: Date.now(), messages: after, sessions: await realCount("sessions").then((n) => n ?? 0) });
    return {
      kind: "restored",
      previous: previous ?? undefined,
      current,
      restoredRows: res?.rows ?? after,
    };
  } catch (e) {
    // 自检失败绝不影响启动
    return { kind: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 旧库里还有消息吗（只读 `dry_run` 扫描） */
async function legacyHasMessages(
  port: { data: unknown },
  legacyPath: string | null,
): Promise<boolean> {
  if (!legacyPath) return false;
  try {
    const probe = port.data as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    if (!probe.command) return false;
    const r = await probe.command<{ per_table?: Array<{ table: string; rows: number }> }>(
      "migration.auto",
      { legacy_path: legacyPath, dry_run: true },
    );
    return (r.per_table ?? []).find((t) => t.table === "messages")?.rows ? true : false;
  } catch {
    return false;
  }
}
