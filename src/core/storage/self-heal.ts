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

/**
 * 用 `crud.count` 读真实行数（结构化返回，不走会被压平的 execute）。
 *
 * **读不到就返回 null —— 绝不返回 0**（第 11 轮修正）。
 *
 * 为什么这一点是安全关键：调用方要根据这个数判断"用户内容是不是丢了"，
 * 而一旦判定为"丢了"，它会去跑一次 `migration.auto` —— 那个命令**会重写整库**。
 * 也就是说：**"读不到"被当成"是 0"= 可能对一份完好的数据库执行破坏性恢复**。
 * 真机证据（`storage_audit`）：2026-09-17T01:13:34Z 一次性删掉 sessions 3 行 +
 * messages 821 条（全部）+ tool_calls 883 + session_events 2131，与"恢复/迁移"
 * 同秒发生 —— 详见 `docs/L3-DELETION-PLAN.md` 第五节。
 *
 * 顺带把失败原因打出来：原来 `catch { return null }` 把"为什么读不到"吞掉了，
 * 出事时没有任何线索。
 */
async function realCount(table: string): Promise<number | null> {
  try {
    const port = getStoragePort();
    // `crud.count` 是查询型命令：`query` 会把它当"取列表"处理，所以这里用 command 拿结构化结果
    const probe = port.data as unknown as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    if (!probe.command) {
      console.warn(`[Storage] 自检：端口没有 command 能力，无法读取 ${table} 的真实行数（本次不判定）`);
      return null;
    }
    const r = await probe.command<{ count?: number }>("crud.count", { table });
    if (typeof r?.count === "number") return r.count;
    console.warn(`[Storage] 自检：crud.count(${table}) 返回的形状不符合契约：`, r);
    return null;
  } catch (e) {
    console.warn(`[Storage] 自检：读取 ${table} 的真实行数失败（本次不判定，避免误恢复）:`, e);
    return null;
  }
}

function readWatermark(
  settings: Array<{ key: string; value: string }>,
): { watermark: Watermark | null; read: boolean } {
  /**
   * ## "读不到"与"真是 0"必须分开（B-9）
   *
   * 原来这里返回 `Watermark | null`，调用方写 `(previous?.messages ?? 0) >= 阈值` ——
   * `?? 0` 把"这一行压根没读到"（settings 面读失败、key 不存在、JSON 坏了）
   * 悄悄当成"上次水位是 0"，于是判定"不异常"、不恢复。那一刻自愈是**静默解除武装**的。
   *
   * 三态在这里表达清楚：
   * - `read: false` → 这一行**没读到**（settings 项缺失或解析失败）：不能当成 0；
   * - `read: true, watermark: null` → 明确"从来没有过水位"（全新用户/第一次启动）；
   * - `read: true, watermark: {...}` → 正常。
   *
   * 为什么区分这件事重要：`messages = 0 且上次水位 ≥ 50` 才会触发恢复，
   * 而"读不到"时**不该恢复**（那可能是读抖动）；但如果把它当成 0，
   * 就变成"永远不恢复"——两者都是错的方向，只有分开才能各自如实上报。
   */
  const entry = settings.find((s) => s.key === MARKER_KEY);
  if (!entry) return { watermark: null, read: true }; // 明确"还没有水位"
  const raw = entry.value;
  if (!raw) return { watermark: null, read: false };
  try {
    const parsed = JSON.parse(raw) as Watermark;
    if (typeof parsed?.messages !== "number") return { watermark: null, read: false };
    return { watermark: parsed, read: true };
  } catch {
    return { watermark: null, read: false };
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
 *
 * ## B-9 更正：它**不是**"全仓 0 调用者的死代码"
 *
 * 审阅时看它像没人调用（连带 `store.ts::reloadSessionMessages` 也"不可达"），
 * 实际调用点是 `store.ts:334`（`loadMessages` 里 `Promise.all` 取到它之后
 * `await guardContentBeforeSessionOpen(await legacyDbPath())`）。**已经接线，不要删。**
 *
 * 之所以看起来"没人用"：它是**动态 import** 取的（`const [{ guardContentBeforeSessionOpen }] = await Promise.all([...])`），
 * 静态搜索 `guardContentBeforeSessionOpen(` 之外还得搜 `import("./core/storage/self-heal")`。
 * 记在这里，免得下一次审计又把它当死代码删掉 —— 删了就等于把"使用中数据消失"的
 * 第二道防线拆了（那道防线覆盖的正是启动自检覆盖不到的那段时间）。
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
    // 第 19 轮：`if (port.kind !== "rust") return { kind:"unavailable", reason:`引擎为 ${port.kind}` }`
    // 已删 —— `kind` 是常量 "rust"，它恒不成立；"没有可用存储"只剩"端口未注册"一种形态（上一行已兜住）。

    const settingsPage = await port.data.query<{ key: string; value: string }>("crud.list", {
      table: "settings",
      limit: 2000,
    });
    const watermarkRead = readWatermark(settingsPage.items ?? []);
    const previous = watermarkRead.watermark;

    /**
     * ⚠️ **读不到 ≠ 是 0**（第 11 轮修正，安全关键）。
     *
     * 这两个计数是"要不要恢复"的唯一依据，而恢复会**重写整库**。原来的写法是
     * `(await realCount("messages")) ?? 0` —— 一次读失败（端口正在启动、命令超时、
     * 契约不匹配）就会被当成"一条消息都没有"，进而对一份**完好的数据库**执行
     * 破坏性恢复。真机上看到的那次"821 条全部被删又重灌"就发生在这条判据上。
     *
     * 现在的规则：**读不到就不判定**（既不恢复、也不改水位）。代价是"这一次自检没生效"，
     * 而数据本来就在那里；下一次自检还会再来。
     */
    const messagesRaw = await realCount("messages");
    if (messagesRaw === null) {
      return { kind: "unavailable", previous: previous ?? undefined, reason: "消息行数读取失败，本次不判定" };
    }
    /**
     * 第二次确认：0 是一个"要么真、要么读错了"的值，而二者的后果极不对称
     * （误判 = 重写整库；多读一次 = 几十毫秒）。所以 0 必须**连读两次都是 0** 才算数。
     */
    let messages = messagesRaw;
    if (messages === 0) {
      await new Promise((r) => setTimeout(r, 250));
      const again = await realCount("messages");
      if (again === null) {
        return { kind: "unavailable", previous: previous ?? undefined, reason: "复核读取失败，本次不判定" };
      }
      if (again > 0) {
        // 复核推翻了"0"这个读数 → 内容其实是健康的，按正常路径继续（会写水位）
        console.warn(`[Storage] 自检：首次读到 0 条消息，复核读到 ${again} 条 —— 判定为读抖动，不恢复`);
      }
      messages = again;
    }
    /**
     * `sessions` 只用于**报告**（水位里的字段），不参与任何判定：
     * 恢复与否只看 `messages` 与水位。所以这里允许 `?? 0` 兜底，但消息数不允许 ——
     * 两者在"读不到"时的后果完全不对称。
     */
    const sessions = (await realCount("sessions")) ?? 0;
    const current: Watermark = { at: Date.now(), messages, sessions };

    // 只要有消息，就认为内容健康 —— 只更新水位（运行期核对时跳过，省一次写）
    if (messages > 0) {
      if (!opts.quietWhenHealthy) await writeWatermark(current);
      return { kind: "ok", previous: previous ?? undefined, current };
    }

    /**
     * 一条消息都没有：只有"上一次明明有很多"才算异常。
     *
     * ## B-9：水位**读不到**时不许当成 0
     *
     * `previous?.messages ?? 0` 把"这一行没读到"与"上次水位是 0"混成一件事：
     * 前者会让 `suspicious` 恒为 false → **自愈静默解除武装**（而且没有任何痕迹）。
     * 现在分开处理：
     * - 水位行读不到（`read: false`）→ 如实上报"本次不判定"，**也不写水位**
     *   （写下去等于用"现在的 0"覆盖掉"上次的高水位"，那才是真正的永久解除武装）；
     * - 明确"从来没有过水位"（`read: true` 且 `watermark === null`）→ 全新用户，
     *   正常写水位后返回 ok（这是原语义，保留）。
     */
    if (!watermarkRead.read) {
      reportActionFailure(
        "storage.selfHeal",
        new Error("水位记录读不到，无法判断内容是否异常丢失"),
        "水位记录读不到（settings 项缺失或解析失败）—— 本次自检不判定（也不覆盖水位）；" +
          "下一次自检会重试；若持续如此，说明 settings 面写入有问题",
      );
      return {
        kind: "unavailable",
        previous: undefined,
        current,
        reason: "水位记录读不到，本次不判定",
      };
    }
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
      /**
       * 这里**仍然写水位**：本次判定已经做完，而且"旧库没有可恢复内容"意味着
       * 自愈这条路已经走到头了；继续留着旧水位只会让每次启动都重复报一次同样的告警。
       * 争议点记在这里：如果哪天旧库可用了（用户接回旧库文件），这个覆盖会让自愈
       * 失去触发条件 —— 那时应当改成"只在用户显式要求时覆盖"。
       */
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
    /**
     * ## B-9：恢复之后必须**复核**，成功了才清标记（写水位）
     *
     * 原来这里是 `const after = (await realCount("messages")) ?? 0;` 然后**无条件**
     * `writeWatermark({ messages: after })`，并返回 `kind: "restored"`。三种坏形态：
     *
     * 1. `migration.auto` 报错（`probe.command` 不存在、命令被拒、旧库路径过期）→
     *    异常被下面那个大 catch 吞成 `unavailable`，而**水位已经被写成 0** ——
     *    下次启动"上次水位是 0" → 不再判定异常 → **自愈被永久解除武装**；
     * 2. 恢复"成功"但一条都没搬回来（`after` 仍是 0）→ 同样把水位清成 0，
     *    而且对外报 `kind: "restored"`（**与事实相反的假成功**）；
     * 3. `realCount` 复核读不到（null）→ `?? 0` 又走回形态 2。
     *
     * 现在的规则：
     * - 复核**读到了**且 > 0 → 才算恢复成功，才更新水位（用新的真实行数）；
     * - 复核读不到或仍是 0 → **保持原水位不动**（这是关键：旧水位是"这里曾经有很多内容"
     *   的唯一记录，清掉它等于让下一次自检失去判据），如实上报失败原因，返回 `suspicious`。
     */
    const after = await realCount("messages");
    if (after === null) {
      reportActionFailure(
        "storage.selfHeal",
        new Error("恢复后复核读取失败"),
        "已执行旧库恢复，但无法确认恢复结果 —— 保持原水位，下一次自检会重试",
      );
      return {
        kind: "unavailable",
        previous: previous ?? undefined,
        current,
        reason: "恢复后复核读取失败（水位未改动）",
      };
    }
    if (after <= 0) {
      reportActionFailure(
        "storage.selfHeal",
        new Error("旧库恢复执行了但没有恢复出任何消息"),
        `已对旧库执行恢复，复核仍是 0 条消息（旧库报告搬运 ${res?.rows ?? 0} 行）—— ` +
          "保持原水位，下一次自检会重试；需要人工确认旧库是否真的有内容",
      );
      return {
        kind: "suspicious",
        previous: previous ?? undefined,
        current,
        reason: "恢复后复核仍是 0 条（水位未改动）",
      };
    }
    await writeWatermark({
      at: Date.now(),
      messages: after,
      sessions: (await realCount("sessions")) ?? 0,
    });
    console.log(`[Storage] 自检恢复完成并复核通过：现在有 ${after} 条消息`);
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
