/**
 * 存储迁移的启动引导（P3）：把 Rust 端口注册进端口注册表，并**如实上报**失败。
 *
 * ## 回滚开关（这是本文件存在的第二个理由）
 *
 * 迁移期必须能"一键退回 WASM"。开关是 **localStorage**（而不是数据库里的设置）——
 * 这是刻意选择：如果开关存在数据库里，那么"数据库读不出来"时你就无法回退，
 * 而那恰好是最需要回退的时刻。存储层的开关必须住在存储层之外。
 *
 *   localStorage.setItem("codem-storage-engine", "wasm")   // 强制回退（改完刷新即生效）
 *   localStorage.setItem("codem-storage-engine", "rust")   // 强制走 Rust
 *   删除该键 = 默认（迁移期间由 DEFAULT_ENGINE 决定）
 *
 * ## 失败为什么要上报而不是静默
 *
 * 如果 Rust 引擎打不开（磁盘满、库损坏、被别的进程锁住），而代码只是 `catch {}`，
 * 那么所有走端口的读写都会变成"同步读拿到默认值 + 写入静默丢失" ——
 * 这正是本项目一直在消灭的 B 类"假成功"。所以这里统一走 `reportActionFailure`，
 * 让用户和日志都能看见。
 */

import { STORAGE_ENGINE_KEY, getStoragePort, hasStoragePort, setStoragePort, type StoragePort } from "./port";
import { RustStoragePort, type StorageTransport } from "./rust-port";
import { reportActionFailure } from "./persist-failure";
import { domainEnsureLoaded } from "./domain-store";

/**
 * 默认引擎（P5 第 2 段：已切到 `rust`）。
 *
 * ## 为什么现在敢切
 *
 * 切换的前提不是"代码写完了"，而是**默认路径上不再有只能靠 WASM 才能工作的域**。
 * 切之前逐条查过并补上了：
 * - `projects` 域（真机上 `createProject` 直接抛 sql.js 的
 *   "tried to bind a value of an unknown type (undefined)" —— 它一直没接过端口）；
 * - `message_feedback` 的四列（`note` / `version` / `created_at` / `updated_at`）
 *   原来只在 `llm/feedback.ts` 里运行期 ALTER，真源与 Rust 侧都没有 →
 *   宽松版反馈在 Rust 引擎下**写不进去**（真机复现，已修）；
 * - `llm/feedback.ts` 的四个操作全部改走域端口。
 *
 * ## ✅ 回滚开关已退役（第 15 轮，v1.16.62）
 *
 * 迁移期靠 `localStorage["codem-storage-engine"] = "wasm"` 一键回退到旧引擎。
 * 现在 **SQLite 引擎已经完全从渲染进程移除**（L1 清零、端口模式套件全绿），
 * 那个开关已经没有可回退的目标了 —— 继续留着它只会制造一个**假的**安全感：
 * 用户以为"切回去还能用"，实际切过去没有任何引擎可用。
 *
 * 所以开关**不再被读取**（`selectedEngine()` 恒为 `rust`）。真正的回退手段是
 * **应用级**的：装回上一版安装包 + 旧库 `codem-db.bin` 始终只读不改。
 * 常量 `STORAGE_ENGINE_KEY` 保留只是为了清理历史 localStorage 键（见 `settings` 的启动清理）。
 */
export const DEFAULT_ENGINE: "rust" = "rust";

export type StorageBootResult =
  | {
      kind: "registered";
      engine: "rust";
      /** 本次调用是否真的完成了打开与预热（false = 复用已注册的端口） */
      opened: boolean;
      /** 健康快照。复用已注册端口时为 undefined —— 调用方不得据此判断"引擎坏了" */
      health?: { ready: boolean; path?: string; tables?: number; journalMode?: string };
    }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: unknown };

/**
 * 当前存储引擎 —— **恒为 `rust`**（第 15 轮：回滚开关退役）。
 *
 * 保留这个函数而不是直接删掉调用点，是为了：
 * 1. 调用方（`registerRustStoragePort` / `App.tsx` 的诊断日志）不必改形状；
 * 2. 把"为什么恒为 rust"写在一处：**旧引擎已经不存在了**，
 *    唯一的存储实现就是 Rust 端口（`localStorage` 里那个开关不再被读取）。
 *
 * 历史背景：迁移期这里读 `localStorage["codem-storage-engine"]`，
 * `"wasm"` 即回退到渲染进程内的 sql.js。那个引擎已经随 L1 清零一起移除。
 */
export function selectedEngine(): "rust" {
  return DEFAULT_ENGINE;
}

/**
 * 注册 Rust 存储端口并预热配置面。
 *
 * - 未选择 rust → 直接跳过（返回 `skipped`，**不是**失败）
 * - 已经注册过 → 幂等复用（热重载 / StrictMode 双调用不会重复预热）
 * - 打开失败 → 上报 + 返回 `failed`，**绝不注册一个半死的端口**
 *   （注册了但不可用最危险：调用方以为有后端，实际全部静默失败）
 */
export async function registerRustStoragePort(
  transport?: StorageTransport,
  label = "storage.bootstrap",
): Promise<StorageBootResult> {
  const engine = selectedEngine();
  if (engine !== "rust") {
    return { kind: "skipped", reason: `当前引擎为 ${engine}（未启用 Rust 存储）` };
  }
  if (hasStoragePort()) {
    const existing = getStoragePort();
    if (existing.kind === "rust") {
      // 复用：**不重复预热**（StrictMode 双调用 / 热重载都会走到这里）。
      // 注意 `opened: false` + 无 health：调用方不得拿"没有 health"当成"引擎没就绪"。
      return { kind: "registered", engine: "rust", opened: false };
    }
    // 已有 WASM 端口却要求 rust：说明启动顺序有问题，如实上报而不是悄悄替换
    reportActionFailure(
      label,
      new Error("端口已注册为 wasm，无法切换为 rust（当前构建里旧引擎已不存在）"),
      "存储引擎未就绪：本进程没有可用存储",
    );
    return { kind: "failed", error: new Error("端口类型冲突") };
  }

  const port = new RustStoragePort(transport, (stream, e, note) => {
    reportActionFailure(`${label}.${stream}`, e, note);
  });

  try {
    /**
     * 第 18 轮：这里原来会 `markLegacyDbNotUsed()`（告诉最底层"本进程不用旧库"，
     * 好让那些"端口没接手就回退旧库"的分支拿到 null 而不是抛 `Database not initialized`）。
     *
     * 那个调用连同旧引擎一起删掉了：现在**没有任何回退分支、也没有旧库句柄** ——
     * 端口没注册就是没有存储（`storageUnavailable()` 为真），写入路径会如实上报。
     */
    const health = await port.start();
    setStoragePort(port);
    /**
     * 诊断入口：在**应用自己的上下文里**跑一条仓储命令并打印结果。
     *
     * 为什么需要它：真机排查时"CLI 读得到、应用读不到"这种分歧最难查 ——
     * CLI 走的是另一个进程、另一次 `Engine::open`，看不见渲染侧端口的真实行为。
     * 这个入口让排查者（以及真机验收脚本，经 CDP）能直接问应用：
     * "你这条命令拿到了什么？"—— 与 `codem-db-cli` 的 `invoke` 同形，
     * 但不接受 SQL、只走白名单命令，所以不放松任何安全边界。
     */
    (globalThis as unknown as Record<string, unknown>).__codemDb = async (
      command: string,
      params: Record<string, unknown> = {},
    ) => {
      const probe = port.data as unknown as {
        command?: <T>(c: string, p?: Record<string, unknown>) => Promise<T>;
      };
      if (probe.command) return await probe.command(command, params);
      return await port.data.execute(command, params);
    };
    return {
      kind: "registered",
      engine: "rust",
      opened: true,
      health: {
        ready: health.ready,
        path: health.path,
        tables: health.tables,
        journalMode: health.journalMode,
      },
    };
  } catch (e) {
    /**
     * ⚠️ 第 18 轮：失败信息改了，并且**广播"存储不可用"**。
     *
     * 旧文案"已保持 WASM 数据库；设置项可能无法保存"是迁移期的话 —— 旧引擎已经不存在，
     * 现在引擎起不来就是**没有存储**。App 收到 `codem:storage-unavailable` 后会
     * 把当前会话抢救成 JSON 并提示用户（这正是旧 `codem:db-fatal` 那条抢救链，
     * 换了生产者而已）。
     */
    reportActionFailure(label, e, "Rust 存储引擎未能启动：本进程没有可用存储（写入会如实上报失败）");
    const { notifyStorageUnavailable } = await import("./health");
    notifyStorageUnavailable("存储引擎未能启动（Rust 侧打开失败）", e instanceof Error ? e.message : e);
    return { kind: "failed", error: e };
  }
}

/**
 * 首屏要用到的**热表**（域镜像预取的清单）。
 *
 * 判据是"首屏或首个交互会读到它"，而不是"重要"：漏一张，那张表对应的面板
 * 就还是会掉进"首次渲染读到空、之后没人重读"的坑里。
 */
export const HOT_DOMAIN_TABLES: readonly string[] = [
  "projects",
  "sessions",
  "v2_sessions",
  "notebooks",
  "notebook_groups",
  "goals",
  "inbox",
  "issues",
  "squads",
  "squad_members",
  "flashcards",
  "agent_profiles",
  "prompt_drafts",
  "turn_file_changes",
  "recovery_data",
  "accounts",
  "notes",
  "mcp_servers",
  "quick_phrases",
];

/**
 * **首屏之前把热表的域镜像拉齐**（第 12 轮）。
 *
 * ## 为什么必须在首屏之前做，而不是"就绪后重读"
 *
 * 域镜像的**读是同步的**（React 渲染路径里直接调 `listProjects()` 这类函数），
 * 而**加载是异步的**（一次 IPC）。两者之间那个窗口就是问题：
 *
 * - 面板首次渲染时读一次 → 镜像还没就绪 → 拿到"该域的合理空结果"（B 态的正确行为）；
 * - 而**没有任何东西会在稍后触发重读** —— 项目列表之所以没事，是因为
 *   `App.tsx` 里给它单独打了一个"端口就绪后重新加载"的补丁（第 24 轮），
 *   其余十几个域（目标 / 收件箱 / 问题 / 团队 / 闪卡 / 画像 / 草稿 / 轮次文件变更…）
 *   **一个都没有**。
 *
 * 真机实测（v1.16.57 启动日志）：`[Store] loadFromDB: found 0 "projects"` →
 * 紧接着（端口就绪后重读）`found 1 "projects"` —— 空读窗口是**可复现的**。
 *
 * 所以把就绪窗口挪到首屏之前：这里一次性触发全部热表加载并等它们就绪。
 * 超时/被拒的表不会被静默忽略 —— 返回的 `pending` 会进日志，调用方还可以据此
 * 注册"就绪后重读"作为兜底。
 *
 * ## 边界（为什么不会拖垮启动）
 *
 * - 单表超时 `perTableMs`（默认 1200ms）：一张坏表不会拖住整个启动；
 * - 总超时 `totalMs`（默认 2500ms）：即使全部超时，启动也只多花 2.5 秒；
 * - 表都小（几十到几百行）：正常情况下这一步是几十毫秒。
 */
export async function prefetchDomainMirrors(
  opts: { tables?: readonly string[]; perTableMs?: number; totalMs?: number } = {},
): Promise<{ ready: string[]; pending: string[]; ms: number }> {
  const tables = opts.tables ?? HOT_DOMAIN_TABLES;
  const perTableMs = opts.perTableMs ?? 1200;
  const totalMs = opts.totalMs ?? 2500;
  const started = Date.now();

  if (!hasStoragePort()) return { ready: [], pending: [...tables], ms: 0 };
  const port = getStoragePort();
  if (port.kind !== "rust") return { ready: [], pending: [...tables], ms: 0 };
  const probe = port as unknown as {
    domains?: { isReady?: (t: string) => boolean };
  };
  if (!probe.domains?.isReady) return { ready: [], pending: [...tables], ms: 0 };

  const jobs = tables.map(
    (t) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        domainEnsureLoaded(t, finish);
        setTimeout(finish, perTableMs);
      }),
  );
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, totalMs))]);

  const ready: string[] = [];
  const pending: string[] = [];
  for (const t of tables) {
    (probe.domains.isReady(t) ? ready : pending).push(t);
  }
  return { ready, pending, ms: Date.now() - started };
}

/** 退出前的收尾：排空写队列 + checkpoint（不是整库导出） */
export async function shutdownRustStoragePort(): Promise<void> {
  if (!hasStoragePort()) return;
  const port = getStoragePort();
  if (port.kind !== "rust") return;
  try {
    await (port as RustStoragePort).stop();
  } catch (e) {
    // 退出阶段失败只记录，不阻塞退出（数据仍在 WAL 里，下次打开会继续）
    reportActionFailure("storage.shutdown", e, "存储收尾未完成，数据仍在 WAL 中，下次启动会继续");
  }
}

/**
 * **首次启动自动迁移**（P5 第 6 段）：把旧库（WASM/sql.js 落盘的 `codem-db.bin`）
 * 搬进 Rust 库。
 *
 * ## 为什么必须自动（而不是让用户手工跑脚本）
 *
 * 引擎默认切到 rust 之后，**渲染进程不再加载 WASM 库** —— 那是"内存不再放大"的前提。
 * 但也因此：用户的会话/消息只存在于旧库里，新库是空的 → 界面会显示"暂无对话"。
 * 让用户自己跑 `node tools/migrate/storage-migrate.mjs` 不是产品该有的行为，
 * 所以这一步由应用自己做，而且**由 Rust 侧做**（在 Rust 里直接只读打开旧库文件；
 * 渲染侧读会把整库拉回内存，把省下的全花回去）。
 *
 * ## 触发条件（三条同时满足才搬，避免误搬）
 *
 * 1. 端口是 rust 且已预热（否则谈不上搬）；
 * 2. **新库里没有任何会话**（`sessions = 0`）—— 有会话就说明用户已经在新库上工作过，
 *    绝不能再用旧库覆盖（那会丢掉新库里的数据）；
 * 3. 旧库文件存在、且**没有迁移标记**（`codem-storage-migrated-at`）。
 *
 * ## 为什么可以放心 `replace`（清空再导入）
 *
 * 条件 2 保证"新库里没有用户数据"：schema 阶段只种了一行全局项目，设置也可能是
 * 上一版 `importSettingsFromLegacyDb` 搬过的。旧库才是权威源，
 * 所以"先清空再导入"不会丢任何东西 —— 而且这避免了主键冲突（实测踩到过
 * `UNIQUE constraint failed: projects.id`）。
 *
 * ## 失败怎么办
 *
 * Rust 侧对账不通过就**不写标记**，这里如实上报。下次启动会再试 ——
 * 半成品不会被当成"迁移完成"，用户的旧库也一直在（只读打开，从不修改）。
 */
/**
 * **一次性搜索索引修复**（第 25 轮）：给"已经迁移过"的用户补上 FTS 重建。
 *
 * ## 为什么需要单独一步
 *
 * 中文搜索依赖 CJK bigram 切分，而**迁移搬进来的 `session_fts` 是老库那份
 * unicode61 时代的原始文本** → 英文能搜、**中文恒为 0 条**
 * （真机实测：`消息` 在库里 LIKE 命中 21 行、FTS 查询 0 条）。
 *
 * 修法是在自动迁移末尾加 `fts.rebuild_all` —— 但**已经跑过迁移的库有标记**，
 * 迁移会（按设计）跳过，于是这些用户永远拿不到修复。
 * 所以这里再补一个**独立的**标记与一次重建：只在"已迁移但还没修过索引"时执行一次。
 *
 * 用独立标记而不是每次启动都重建：重建代价与消息数成正比，
 * 每次启动都做等于把启动时间绑在语料大小上。
 */
export async function repairSearchIndexOnce(
  label = "storage.fts-repair",
): Promise<{ kind: "skipped"; reason: string } | { kind: "repaired"; sessions: number; refreshed: number } | { kind: "failed"; error: unknown }> {
  if (!hasStoragePort()) return { kind: "skipped", reason: "端口未注册" };
  const port = getStoragePort();
  if (port.kind !== "rust") return { kind: "skipped", reason: `引擎为 ${port.kind}` };

  const MARKER = "codem-fts-bigram-rebuilt";
  try {
    const settings = await port.data.query<{ key: string; value: string }>("crud.list", {
      table: "settings",
      limit: 2000,
    });
    if (settings.items?.some((s) => s.key === MARKER)) {
      return { kind: "skipped", reason: "已修过搜索索引" };
    }
  } catch {
    /* 读不到设置不阻塞：宁可多修一次，也不要漏修 */
  }

  try {
    // `command` 是 P5 第 6 段加的结构化结果入口（`execute` 会压成 {written}）；
    // 类型上它在 StorageDataPort 里还没声明，所以这里显式标注一次。
    const data = port.data as unknown as {
      command: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    const res = await data.command<{ sessions?: number; refreshed?: number }>("fts.rebuild_all", {});
    const sessions = res?.sessions ?? 0;
    const refreshed = res?.refreshed ?? 0;
    // 写标记（走端口；失败也不影响本次修复的效果）
    try {
      await data.command("settings.set", { key: MARKER, value: String(Date.now()) });
    } catch { /* 标记没写上 → 下次启动会再修一遍（幂等、只是多花一次时间） */ }
    console.log(`[Storage] 已重建搜索索引（中文搜索修复）：${sessions} 个会话 / 重写 ${refreshed} 条`);
    return { kind: "repaired", sessions, refreshed };
  } catch (e) {
    reportActionFailure(label, e, "搜索索引重建未完成（中文搜索可能仍搜不到；下次启动会重试）");
    return { kind: "failed", error: e };
  }
}
/**
 * 新库的"关键表"是否**全部为空**（消息 / 会话 / 事件 / 工具调用）。
 *
 * 为什么单看 `messages` 不够：真机事故里这四张表是一起变空的，
 * 而"只有消息空、会话还在"也可能是正常的中间状态（用户刚开始用）。
 * 四张都空 + 旧库有数据 = 几乎可以确定是索引不完整，而不是用户真把东西删光了。
 */
async function newDbCoreTablesEmpty(port: StoragePort): Promise<boolean> {
  for (const table of ["messages", "sessions", "session_events", "tool_calls"]) {
    try {
      const page = await port.data.query<{ items?: unknown[] }>("crud.list", { table, limit: 1 });
      if ((page.items?.length ?? 0) > 0) return false;
    } catch {
      // 读不到（表不存在等）不算"空"：宁可不动，也不误判成需要重建
      return false;
    }
  }
  return true;
}

/**
 * 旧库里是否有**值得恢复的内容**（消息 > 0）。
 *
 * 只读、只数一行：这是"要不要允许自愈重建"的唯一依据 ——
 * 旧库也空的话，重跑迁移没有意义（也不该动任何东西）。
 */
async function legacyDbHasContent(
  port: StoragePort,
  legacyPath: string,
): Promise<boolean> {
  try {
    /**
     * 用 `migration.auto` 的 **`dry_run`**：它只**只读**扫一遍旧库并回报逐表行数，
     * 不写任何东西（`migrate.rs:1417`）。这是渲染侧能拿到的、最便宜也最安全的
     * "旧库有没有内容"的答案 —— 比在渲染进程里再开一个 sql.js 读旧库轻得多，
     * 也避开了 FTS4 只读连接上的 `quick_check` 陷阱。
     */
    const probe = port.data as unknown as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    if (!probe.command) return false;
    const res = await probe.command<{
      dry_run?: boolean;
      per_table?: Array<{ table: string; rows: number }>;
    }>("migration.auto", { legacy_path: legacyPath, dry_run: true });
    const messages = (res.per_table ?? []).find((t) => t.table === "messages");
    return (messages?.rows ?? 0) > 0;
  } catch {
    /**
     * 拿不到旧库统计时**保守处理**：不触发重建。
     * 宁可让用户看到空列表（并且日志里有明确告警），也不冒"误覆盖"的风险 ——
     * 覆盖是单向的，等一次人工确认的成本远低于把用户数据盖掉。
     */
    return false;
  }
}
export async function migrateFromLegacyDb(
  label = "storage.auto-migrate",
): Promise<{ kind: "skipped"; reason: string } | { kind: "migrated"; tables: number; rows: number } | { kind: "failed"; error: unknown }> {
  if (!hasStoragePort()) return { kind: "skipped", reason: "端口未注册" };
  const port = getStoragePort();
  if (port.kind !== "rust") return { kind: "skipped", reason: `引擎为 ${port.kind}` };

  // 条件 2：**新库里既没有会话、也没有消息**才允许用旧库覆盖。
  //
  // ⚠️ 第 28 轮加固（真机事故后）：原来只判 `sessions > 0`，于是"用户把会话都删了"
  // （或者某次测试/清理把 sessions 清空）就会重新触发一次全量覆盖迁移 ——
  // 而 `migration.auto` 走的是 `replace: true`（**先清空目标表**），
  // 于是一次误触发就把新库里剩下的数据（消息/事件/工具调用）清掉、
  // 再从旧库导入**当时那份旧内容**。实测踩到：Rust 库只剩 1 个笔记本会话、
  // 821 条消息与 2131 条事件全没了（数据在旧库里保住了，但用户看到的是"空的"）。
  //
  // 判据必须是"新库**确实什么都没有**" —— 只看会话不够，因为消息可以比会话活得久。
  try {
    const sessions = await port.data.query<{ id: string }>("crud.list", { table: "sessions", limit: 1 });
    if ((sessions.items?.length ?? 0) > 0) {
      return { kind: "skipped", reason: "新库已有会话数据（不覆盖）" };
    }
    const messages = await port.data.query<{ id: string }>("crud.list", { table: "messages", limit: 1 });
    if ((messages.items?.length ?? 0) > 0) {
      return { kind: "skipped", reason: "新库已有消息数据（不覆盖）" };
    }
    const projects = await port.data.query<{ id: string }>("crud.list", { table: "projects", limit: 5 });
    const userProjects = (projects.items ?? []).filter((p) => p.id !== "" && !String(p.id).startsWith("notebook:"));
    if (userProjects.length > 0) {
      /**
       * ⚠️ 这里**不再直接返回 skipped**（第 31 轮真机事故后的修正）。
       *
       * 实测到的现场：新库里 `projects=3 / notebooks=1 / notebook_sources=8` 都搬好了，
       * 而 **`messages=0 / sessions=1 / session_events=0 / tool_calls=0`** ——
       * 也就是"导入事务在搬小表之后就回滚了"的半迁移状态。
       *
       * 旧库是**完好**的（`messages=821 / sessions=3 / session_events=2198 / projects=3`，
       * 数据没丢），但"有用户项目就不覆盖"这条守卫把重试**永久挡住了**：
       * 用户看到的是项目在、会话和消息全空，而且**再怎么重启也不会自愈**。
       *
       * 判据改成"**明显不完整**才允许再搬一次"：有项目却没有任何消息 ——
       * 正常库里不可能有这种形态（用户至少会有一条消息才会产生会话/项目）。
       * 真正"用户自己删光了消息"的情况由 `auto_migrate` 的 `replace: true` 兜住，
       * 而它搬运的正是旧库那份权威内容，不会造成新的丢失。
       */
      const probe = await port.data.query<{ id: string }>("crud.list", { table: "messages", limit: 1 });
      const hasAnyMessage = (probe.items?.length ?? 0) > 0;
      const sessionProbe = await port.data.query<{ id: string }>("crud.list", { table: "sessions", limit: 5 });
      const userSessions = (sessionProbe.items ?? []).filter(
        (s) => !String((s as { project_id?: string }).project_id ?? "").startsWith("notebook:"),
      );
      if (hasAnyMessage || userSessions.length > 0) {
        return { kind: "skipped", reason: "新库已有用户项目与会话数据（不覆盖）" };
      }
      // 落到这里：有用户项目、却一条用户消息都没有 → 半迁移，允许重搬（幂等覆盖）
    }
  } catch (e) {
    return { kind: "skipped", reason: `无法查询新库数据：${String(e)}` };
  }

  // 条件 3：旧库路径 + 迁移标记
  const legacyPath = await legacyDbPath();
  if (!legacyPath) return { kind: "skipped", reason: "拿不到应用数据目录" };

  const rust = port as unknown as {
    engine: { health?: () => Promise<unknown> };
    data: {
      execute: (cmd: string, params?: Record<string, unknown>) => Promise<unknown>;
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
  };

  // 先看标记（在旧库里找过没有意义 —— 标记写在新库）：读一次新库的 settings
  try {
    const settings = await port.data.query<{ key: string; value: string }>("crud.list", {
      table: "settings",
      limit: 2000,
    });
    if (settings.items?.some((s) => s.key === "codem-storage-migrated-at")) {
      /**
       * ⚠️ 有标记 ≠ 数据还在（第 31 轮真机事故的修正）。
       *
       * 实测到的现场：迁移**对账通过、标记已写**（`codem-storage-migrated-at` 在），
       * 但之后新库的 `messages / sessions / session_events / tool_calls` 又变回了 0
       * —— 而旧库那份完好（`messages=821 / sessions=3`）。
       * 结果是：用户看到项目在、会话和消息全空，而且**重启永远不会自愈**
       * （标记把迁移彻底挡住了）。
       *
       * 所以这里加一道**对账自愈**：标记存在、但新库的关键表为空而旧库非空 →
       * 判定为"数据不完整"，允许重跑一次迁移（`replace: true` 幂等，内容是旧库那份权威副本）。
       * 判据刻意保守：只在"新库为空 + 旧库非空"时触发，绝不覆盖任何非空数据。
       */
      const stillEmpty = await newDbCoreTablesEmpty(port);
      const legacyHas = await legacyDbHasContent(port, legacyPath);
      if (!(stillEmpty && legacyHas)) {
        return { kind: "skipped", reason: "已有迁移标记" };
      }
      reportActionFailure(
        label,
        new Error("新库关键表为空但旧库有数据"),
        "检测到查询索引不完整（消息/会话为空，而旧库有数据）—— 正在从旧库重建一次",
      );
    }
  } catch (e) {
    /**
     * ⚠️ **读不到标记与守卫数据 → 本次不迁移**（第 11 轮修正，安全关键）。
     *
     * 原来这里是 `catch { /* 读不到设置不阻塞 *\/ }` —— 直接**继续往下走**去跑迁移。
     * 也就是说：`crud.list(settings)` 一次瞬时失败（引擎刚打开、命令超时、契约变化），
     * 所有守卫（标记在不在、新库是不是空的）**一个都没执行**，直接执行"整库重写"。
     *
     * 这与 `self-heal.ts` 里那处 `?? 0` 是同一类缺陷：**把"读不到"当成"是空的"**。
     * 两者的后果都是对一份完好的库执行破坏性操作，所以规则也统一：
     * 读不到就不动，如实说明，等下一次（数据本来就在那里）。
     */
    return { kind: "skipped", reason: `读不到迁移标记与守卫数据（本次不迁移）：${String(e)}` };
  }

  try {
    interface MigrateResult {
      migrated?: boolean;
      tables?: number;
      rows?: number;
      skipped?: Array<{ what: string; rows: number }>;
    }
    // 用 `command`（结构化结果）而不是 `execute`（会被压成 {written}）——
    // 否则 tables/rows 读不到、`?? 0` 兜底成 0，日志会打出"迁移了 0 张表"这种假成功。
    const res = rust.data.command
      ? await rust.data.command<MigrateResult>("migration.auto", { legacy_path: legacyPath })
      : ((await rust.data.execute("migration.auto", { legacy_path: legacyPath })) as MigrateResult);

    if (typeof res?.tables !== "number" || typeof res?.rows !== "number") {
      // 契约对不上就如实报错，**不猜**（猜出来的 0 会变成一条假成功日志）
      throw new Error(
        `migration.auto 的返回形状不符合契约（期望 {tables, rows}，收到 ${JSON.stringify(res)?.slice(0, 120)}）`,
      );
    }
    const dropped = (res.skipped ?? [])
      .filter((s) => s.what.includes("孤儿"))
      .reduce((a, s) => a + s.rows, 0);
    console.log(
      `[Storage] 已从旧库自动迁移：${res.tables} 张表 / ${res.rows} 行（对账通过` +
        (dropped > 0 ? `；丢弃 ${dropped} 行外键孤儿（父行不存在）` : "") +
        `）`,
    );
    return { kind: "migrated", tables: res.tables, rows: res.rows };
  } catch (e) {
    reportActionFailure(
      label,
      e,
      "旧数据自动迁移未完成（旧库未改动，下次启动会重试；本次仍可正常使用新库）",
    );
    return { kind: "failed", error: e };
  }
}

/** 旧库（sql.js 落盘）的绝对路径 */
export async function legacyDbPath(): Promise<string | null> {
  try {
    const { getAppDataDir } = await import("../file-api");
    const base = await getAppDataDir();
    if (!base) return null;
    const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
    return `${base}${sep}codem-db.bin`;
  } catch {
    return null;
  }
}

/**
 * 一次性把配置面从旧库（WASM）搬进 Rust 库。
 *
 * ## 为什么需要它
 *
 * 切到 Rust 后，`getSetting` 读的是 Rust 库 —— 而 Rust 库刚创建时 `settings` 表是空的，
 * 于是用户所有偏好（主题、字号、语言、显示模式…）会**看起来全部重置**。
 * 用户不会认为"这是迁移"，只会认为"升级把设置弄丢了"。
 *
 * ## 触发条件（严格到不会误触发）
 *
 * 1. 端口是 rust 且**已预热**（预热过才知道 Rust 库到底有什么）；
 * 2. Rust 库里**一个设置都没有**（`keys === 0`）；
 * 3. 旧库可读、且 `settings` 表**确有内容**。
 *
 * 三条同时满足才搬。搬完写一个标记键，保证**只搬一次** ——
 * 否则用户以后"清空某个设置"会被下一次启动从旧库又搬回来（这才是真正难查的 bug）。
 */
export async function importSettingsFromLegacyDb(
  label = "storage.settings-import",
  /**
   * 旧库路径。
   *
   * 由**调用方传入**而不是内部自己解析：`legacyDbPath()` 依赖 `getAppDataDir()`（走 Tauri IPC），
   * 在测试里不可用，而把它放在模块内部会让这个函数**无法被独立测试** ——
   * 实测踩过：用 `vi.mock` 拦不住模块内部函数调用，测试只能看到"返回 0"。
   * 显式传参让依赖可见、可替身，也让调用点（启动流程）自己保证"只在 rust 模式下调用"。
   */
  legacyPathIn?: string | null,
): Promise<number> {
  if (!hasStoragePort()) return 0;
  const port = getStoragePort();
  if (port.kind !== "rust") return 0;

  const stats = port.config.stats();
  if (!stats.warmed) return 0;
  if (stats.keys > 0) return 0; // Rust 库已有设置：不是首次，绝不搬

  const MARKER = "codem-settings-imported-from-legacy";
  let legacy: Array<[string, string]> = [];
  try {
    /*
     * **通过 Rust 只读读旧库**（第 43 轮修正）。
     *
     * 原来这里直接读旧库 —— 而 rust 模式下旧库**从不加载**
     * （`markLegacyDbNotUsed()` 之后没有任何 `initDatabase()`），所以它必定抛
     * `Database not initialized`，被下面的 catch 吞成"返回 0（没搬）"。
     * 也就是说：**这条"配置面补搬"的能力从来没生效过**，是一处静默 no-op。
     * （用户当前没事，是因为全量迁移 `migration.auto` 本来就搬了 `settings` 表 ——
     *   实测 Rust 库 26 条 ≥ 旧库 24 条。但能力本身是坏的。）
     *
     * 现在改走 `legacy.read_table`（只读打开旧库、表名白名单、有行数上限），
     * 它不依赖 sql.js，因此在 rust 模式下真的能工作。
     */
    const legacyPath = legacyPathIn ?? (await legacyDbPath());
    if (!legacyPath) return 0;
    const probe = port.data as unknown as {
      command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
    };
    if (!probe.command) return 0;
    const res = await probe.command<{
      columns?: string[];
      rows?: Array<Array<unknown>>;
    }>("legacy.read_table", { legacy_path: legacyPath, table: "settings", limit: 5_000 });
    const cols = res.columns ?? [];
    const keyIdx = cols.indexOf("key");
    const valIdx = cols.indexOf("value");
    if (keyIdx >= 0 && valIdx >= 0) {
      legacy = (res.rows ?? [])
        .map((row) => [String(row[keyIdx] ?? ""), String(row[valIdx] ?? "")] as [string, string])
        .filter(([k, v]) => k.length > 0 && v.length > 0);
    }
  } catch (e) {
    // 旧库读不到（例如已被删除）：不搬，也不报成故障 —— 全新安装就是这个状态
    return 0;
  }
  if (legacy.length === 0) return 0;

  let imported = 0;
  for (const [key, value] of legacy) {
    // 标记键由这里自己写，不从旧库搬（旧库不会有它，防御性排除）
    if (key === MARKER) continue;
    port.config.set(key, value);
    imported++;
  }
  port.config.set(MARKER, String(Date.now()));
  await (port.config as { flush?: () => Promise<void> }).flush?.();
  console.log(`[Storage] 已从旧库导入 ${imported} 项配置到 Rust 库（仅此一次）`);
  void label;
  return imported;
}
