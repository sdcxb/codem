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

import { STORAGE_ENGINE_KEY, getStoragePort, hasStoragePort, setStoragePort } from "./port";
import { RustStoragePort, type StorageTransport } from "./rust-port";
import { reportActionFailure } from "./persist-failure";

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
 * ## 回滚开关仍然在
 *
 * `localStorage["codem-storage-engine"] = "wasm"` 改完刷新即回退。
 * 注意：要让它真的可用，**sql.js 依赖在本段之后暂时保留**（真机验证过没有回退需求
 * 再单独删除依赖，见 docs 的 P5 顺序说明）。
 */
export const DEFAULT_ENGINE: "wasm" | "rust" = "rust";

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

/** 读回滚开关（localStorage 不可用时退回默认，不抛） */
export function selectedEngine(): "wasm" | "rust" {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_ENGINE_KEY);
    if (raw === "rust" || raw === "wasm") return raw;
  } catch {
    /* 隐私模式等场景下 localStorage 会抛；用默认值 */
  }
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
      new Error("端口已注册为 wasm，无法切换为 rust（回滚开关需要在刷新后生效）"),
      "存储引擎切换未生效，本次仍使用 WASM 数据库",
    );
    return { kind: "failed", error: new Error("端口类型冲突") };
  }

  const port = new RustStoragePort(transport, (stream, e, note) => {
    reportActionFailure(`${label}.${stream}`, e, note);
  });

  try {
    const health = await port.start();
    setStoragePort(port);
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
    reportActionFailure(
      label,
      e,
      "Rust 存储引擎未能启动，已保持 WASM 数据库；设置项可能无法保存",
    );
    return { kind: "failed", error: e };
  }
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
export async function importSettingsFromLegacyDb(label = "storage.settings-import"): Promise<number> {
  if (!hasStoragePort()) return 0;
  const port = getStoragePort();
  if (port.kind !== "rust") return 0;

  const stats = port.config.stats();
  if (!stats.warmed) return 0;
  if (stats.keys > 0) return 0; // Rust 库已有设置：不是首次，绝不搬

  const MARKER = "codem-settings-imported-from-legacy";
  let legacy: Array<[string, string]> = [];
  try {
    const { getDatabase } = await import("./database");
    const db = getDatabase();
    const result = db.exec("SELECT key, value FROM settings");
    if (result.length > 0) {
      legacy = result[0].values
        .filter((row) => typeof row[0] === "string" && typeof row[1] === "string")
        .map((row) => [row[0] as string, row[1] as string]);
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
