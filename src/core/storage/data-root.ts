/**
 * 应用数据根目录 —— **唯一来源是引擎解析出来的库路径**（第 62 轮）。
 *
 * ## 为什么必须问引擎，而不是自己再算一遍
 *
 * 这个仓库为"同一个事实两个来源"付过真代价（第 55 轮真事故）：渲染侧的数据目录走 Tauri 的
 * `app_data_dir()`（Windows = `SHGetKnownFolderPath`），引擎走自己手写的解析
 * （当时读 `APPDATA` 环境变量）—— 两者不等价，于是**渲染侧把日志写进真目录、引擎把库建到别处**，
 * 用户那份数据在仓库工作目录里长出来，差点被 `git add -A` 提交（GitHub push protection 拦下）。
 * 第 55 轮把引擎改成同一个已知文件夹 API，两边"按构造一致"。
 *
 * 但**还有第二个来源没被收掉**：引擎支持 `CODEM_DB_PATH` 显式指定库路径
 * （这是**唯一受支持**的"把库放到别处"的方式，也是便携模式与隔离钻取的入口），
 * 而渲染侧的文件路径**仍然只认 `appDataDir`**：
 *
 * | 渲染侧文件 | 位置来源（本轮之前） |
 * | --- | --- |
 * | 权威追加日志 `<base>/sessions/<sid>.jsonl` | `getAppDataDir()` |
 * | 外置附件正文 `<base>/attachments/…` | `getAppDataDir()` |
 * | 超大工具结果溢出文件 `<base>/spill/…` | `getAppDataDir()` |
 * | 索引重建标记 `<base>/codem-index-rebuild-needed.json` | `getAppDataDir()` |
 *
 * 一旦库被指到别处（`CODEM_DB_PATH`，或标准目录取不到时的兜底 `.codem-portable/`），
 * 就会出现**权威日志与被它支撑的索引不在同一份数据里**：索引在 A、权威副本在 B，
 * 而"从日志重建索引"这条自愈路径会在**另一份数据集**上跑 ——
 * 便携模式把库拷到 U 盘、日志却留在本机；隔离钻取（我自己的验收流程）会**读写用户的真日志**。
 *
 * ## 判据：根目录 = 引擎那份库文件所在的目录
 *
 * `storage_info`（Tauri 命令，第 55 轮就暴露了 `path`/`standard`/`reason`）给出引擎
 * **实际解析出来**的库路径；根目录取它的父目录。于是：
 *
 * - **标准情况下逐字不变**（库在 `%APPDATA%\codem\codem-db-rust.bin`，根目录就是
 *   `%APPDATA%\codem\`，与 `getAppDataDir()` 同一个值）；
 * - 库被指到别处时，渲染侧的文件**跟着走** —— 两个来源合一；
 * - 拿不到 `storage_info`（没有 Tauri、引擎起不来、二进制里没这个命令）→
 *   退回 `getAppDataDir()` 并**记住原因**（`origin` / `fallbackWhy`），
 *   让"这次是按兜底路径放的"可查（不静默）。
 *
 * ⚠️ 刻意**不**跟着走的东西：产品的功能目录（宠物、技能缓存、zvec 产物、GitHub 克隆目标）
 * 与**旧库** `codem-db.bin`（旧引擎的历史落点，从来没在别处过）。
 * 本轮只收"与库同属一份数据集"的存储文件；功能目录要不要进便携模式是**产品决策**。
 */

import { getAppDataDir } from "../file-api";

/** 解析结果的形状（诊断用；`origin` 说明这次根目录是**怎么来的**） */
export interface DataRootInfo {
  /** 数据根目录（**带尾部分隔符**，可直接与文件名拼接） */
  root: string;
  /** `engine` = 来自引擎实际使用的库路径；`app-data-dir` = 兜底 */
  origin: "engine" | "app-data-dir";
  /** 库文件绝对路径（`origin === "engine"` 时给出） */
  dbPath?: string;
  /** 引擎报的"是否标准位置"与原因（原样透传，便于界面/诊断说出真相） */
  standard?: boolean;
  reason?: string;
  /** 兜底时说明**为什么**没能问到引擎 */
  fallbackWhy?: string;
}

/** 从库文件路径推出根目录（含尾部分隔符，与输入的分隔符风格一致） */
export function rootFromDbPath(dbPath: string): string {
  const sep = dbPath.includes("/") && !dbPath.includes("\\") ? "/" : "\\";
  const cut = Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\"));
  if (cut < 0) return `${dbPath}${sep}`; // 裸文件名（不该发生）：就当在当前目录
  return dbPath.slice(0, cut + 1);
}

let cached: Promise<DataRootInfo> | null = null;
let resolvedValue: DataRootInfo | null = null;

/**
 * 数据根目录（**异步**；同一进程内只解析一次**成功结果**）。
 *
 * 并发调用共享同一次解析（缓存的是 Promise），不会发出多条 IPC。
 * ⚠️ **失败不缓存**：解析失败（连 Tauri 数据目录都拿不到）会把缓存清掉，
 * 让"存储晚一点就绪"不是永久性判决 —— 否则一次过早的调用会把这个进程的数据根目录
 * 永久钉在失败态上。
 */
export function resolveDataRoot(): Promise<DataRootInfo> {
  if (!cached) {
    cached = resolveOnce().then(
      (info) => {
        resolvedValue = info;
        return info;
      },
      (e) => {
        cached = null; // 失败不缓存：下次调用可以重试
        throw e;
      },
    );
  }
  return cached;
}

async function resolveOnce(): Promise<DataRootInfo> {
  // ① 问引擎：它实际用的是哪个库文件
  try {
    const invoke = (
      globalThis as {
        __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } };
      }
    ).__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") {
      return await fallback("没有 Tauri 运行时（__TAURI__.core.invoke 不存在）");
    }
    const info = (await invoke("storage_info")) as
      | { path?: unknown; standard?: unknown; reason?: unknown }
      | null;
    const dbPath = typeof info?.path === "string" ? info.path : "";
    if (!dbPath) return await fallback("storage_info 没有给出 path");
    return {
      root: rootFromDbPath(dbPath),
      origin: "engine",
      dbPath,
      standard: info?.standard === true,
      reason: typeof info?.reason === "string" ? info.reason : undefined,
    };
  } catch (e) {
    return await fallback(`storage_info 调用失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 兜底：Tauri 的 `app_data_dir()`（与标准位置同一个值）。
 *
 * ⚠️ 它自己也可能失败（`file-api.ts::tauriInvoke` 直接读 `window.__TAURI__.core`，
 * 没有守卫）—— 那时**必须抛错，绝不退回相对路径**：第 55 轮真事故就是"退回当前目录里的
 * 裸文件名"，让数据落进了仓库工作目录。宁可让这一层失败被调用方如实上报，
 * 也不能让文件悄悄写到"进程当前目录"这种没人能说清的地方。
 */
async function fallback(why: string): Promise<DataRootInfo> {
  try {
    const base = await getAppDataDir();
    if (!base) throw new Error("get_app_data_dir 返回空");
    return { root: base, origin: "app-data-dir", fallbackWhy: why };
  } catch (e) {
    throw new Error(
      `数据根目录解析失败：既问不到存储引擎（${why}），也拿不到 Tauri 数据目录` +
        `（${e instanceof Error ? e.message : String(e)}）。` +
        `本次没有可信的数据落点 —— 拒绝退回相对路径 / 进程当前目录。`,
    );
  }
}

/**
 * 诊断用：**已经解析出来**的信息（没解析过返回 `null`，**不触发**解析）。
 *
 * 用途：把"这次进程的数据根目录是哪来的"写进维护日志/诊断面板 ——
 * 静默地换了数据落点是这个仓库踩过的坑（第 55 轮库建到仓库目录那次就是"没人能说出为什么在那"）。
 */
export function dataRootInfoIfResolved(): DataRootInfo | null {
  return resolvedValue;
}

/** **测试用**：清掉缓存 */
export function __resetDataRootCache(): void {
  cached = null;
  resolvedValue = null;
}
