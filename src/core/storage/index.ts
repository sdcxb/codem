/**
 * 存储层的**对外门面**（第 18 轮：旧引擎的再导出已删除）。
 *
 * 原来这一行是 `export { initDatabase, getDatabase, … } from "./database"` ——
 * 那些符号（含 sql.js 引擎的整库导出/导入）随 L1 一起退役。
 * 维护入口搬到了 `./maintenance`（它本来一行都不跑，见那里的说明）。
 */
export { runDatabaseMaintenance } from "./maintenance";
export * as ProjectStorage from "./project";
export * as SessionStorage from "./session";
export * as MessageStorage from "./message";
export * as AccountStorage from "./account";
export { migrateFromLocalStorage, clearLocalStorage } from "./migration";
