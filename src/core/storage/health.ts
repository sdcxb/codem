/**
 * 存储健康态的**唯一判据**（第 18 轮新增）。
 *
 * ## 它替代的是什么
 *
 * 迁移期各处写的是 `isDatabaseFatal()` —— "旧引擎（sql.js）已经崩了，别再重试/别再写"。
 * 那个函数的语义在新架构下**不再成立**：旧库在 rust 模式下**刻意不加载**，
 * 于是它恒为 `false`，那些守卫全部变成死代码；而它们想守的那件事仍然存在：
 * **本进程没有可用存储时，不要反复重试、也不要假装写成功**。
 *
 * 新架构下"没有可用存储"只有一种可能：**rust 端口没注册**（引擎启动失败）。
 * 所以判据就是它 —— 比"旧库崩了"更贴近事实，而且在真机上真的可能为真
 * （引擎起不来时，各写入路径应当退让并如实上报，而不是狂刷日志）。
 *
 * ## 用法
 *
 * ```ts
 * if (storageUnavailable()) { reportOnce(...); return; }
 * ```
 *
 * ⚠️ 注意与 `hasStoragePort()` 的区别：后者回答"端口对象在不在"
 * （`bootstrap` 注册后即为真），本函数是它的补集，专门给"要不要退让"用。
 */

import { hasStoragePort } from "./port";

/** 本进程当前**没有任何可用存储**（端口未注册）→ 写入路径应退让并如实上报。 */
export function storageUnavailable(): boolean {
  return !hasStoragePort();
}

/**
 * "存储不可用"事件名（第 18 轮）。
 *
 * ## 它接替的是 `codem:db-fatal`
 *
 * 旧引擎用 `codem:db-fatal` 表达"sql.js 模块崩了（OOM / WASM 陷阱），写入已经不可能成功"，
 * App 收到后做两件事：**把当前会话抢救成 JSON**、给用户一条可执行说明。
 * 那个事件的生产者只可能是旧引擎（`noteFatalDbError`）—— 删引擎后它就没人派发了，
 * 而**抢救能力本身仍然要留着**：新架构下"写入不可能成功"的唯一成因是
 * **Rust 引擎没起来**（端口未注册）。
 *
 * 所以判据换成它，事件名也换成不含引擎实现细节的 `codem:storage-unavailable`：
 * 生产者 = `bootstrap` 的注册失败路径（唯一能真正知道"引擎起不来"的地方）。
 */
export const STORAGE_UNAVAILABLE_EVENT = "codem:storage-unavailable";

/** 只派发一次（与旧 `dbFatal` 闩锁同语义：避免每个写路径都弹一次提示） */
let unavailableNotified = false;

/**
 * 标记"本进程存储不可用"并广播一次。
 *
 * @param reason 给用户看的原因（会进 guidance 提示）
 * @param detail 诊断细节（进日志与抢救文件）
 */
export function notifyStorageUnavailable(reason: string, detail?: unknown): void {
  if (unavailableNotified) return;
  unavailableNotified = true;
  const payload = { reason, detail: detail === undefined ? undefined : String(detail) };
  console.error("[Storage] 存储不可用：", reason, payload.detail ?? "");
  try {
    window.dispatchEvent(new CustomEvent(STORAGE_UNAVAILABLE_EVENT, { detail: payload }));
  } catch {
    /* 非浏览器环境（测试/CLI）下 dispatch 失败不影响主流程 */
  }
}

/** 测试隔离：复位"已通知"闩锁 */
export function resetStorageUnavailableNotified(): void {
  unavailableNotified = false;
}

