/**
 * 待处理队列的持久化底座（needs_you / agent_messages）。
 *
 * 背景：两个队列的文件头都写着 "Persistence: … SQLite table"，但**一行读写都没有**，
 * 队列一直是内存 Map —— 重启即丢。表本身在 `codem-db/sql/schema.sql` 里早已存在，
 * 引擎也有通用 `crud.upsert / crud.list / crud.delete`，所以这里只做**薄接线**，
 * 不新增 Rust 命令、不引入第二套存储。
 *
 * 设计约束：
 * - 队列 API 是同步的（回合边界要同步取），所以持久化是**异步写穿**：
 *   写失败只记日志（不阻断回合），读回失败按"没有待处理"处理并记日志；
 * - 端口未注册时不做任何事（测试/纯逻辑环境），注册后由各队列调用 `hydrate` 回填；
 * - 行形状与 schema 一一对应（snake_case），options 以 JSON 字符串存。
 */
import { getStoragePort, hasStoragePort, setStoragePortListener } from "../storage/port";

export type PendingTable = "needs_you_pending" | "agent_messages";

/** 持久化是否可用（端口已注册） */
export function isPendingPersistenceAvailable(): boolean {
  return hasStoragePort();
}

/**
 * 端口注册时回调一次（用于回填）。
 * 返回退订函数；没有端口时也安全。
 */
export function onPendingPersistenceReady(cb: () => void): () => void {
  return setStoragePortListener(() => cb());
}

async function data() {
  if (!hasStoragePort()) return null;
  return getStoragePort().data;
}

/** 读一页行（where 等值；不传 = 全部，受 limit 约束） */
export async function loadPendingRows(
  table: PendingTable,
  where?: Record<string, unknown>,
  limit = 200,
): Promise<Array<Record<string, unknown>>> {
  const port = await data();
  if (!port) return [];
  try {
    const page = await port.query<{ items?: Array<Record<string, unknown>> }>("crud.list", {
      table,
      ...(where ? { where } : {}),
      order_by: table === "agent_messages" ? "sequence" : "created_at",
      limit,
    });
    return Array.isArray(page?.items) ? page.items : [];
  } catch (e) {
    console.warn(`[pending-persistence] 读取 ${table} 失败（按空处理）:`, e);
    return [];
  }
}

/** 整行覆盖写（mode=replace；同一 id 重放安全） */
export async function upsertPendingRow(
  table: PendingTable,
  row: Record<string, unknown>,
): Promise<boolean> {
  const port = await data();
  if (!port) return false;
  try {
    await port.execute("crud.upsert", { table, rows: [row], mode: "replace" });
    return true;
  } catch (e) {
    console.warn(`[pending-persistence] 写入 ${table} 失败（本条只留在内存）:`, e);
    return false;
  }
}

/** 按主键删除（消费/回答后销账） */
export async function deletePendingRow(table: PendingTable, id: string): Promise<boolean> {
  const port = await data();
  if (!port) return false;
  try {
    await port.execute("crud.delete", { table, where: { id } });
    return true;
  } catch (e) {
    console.warn(`[pending-persistence] 删除 ${table}#${id} 失败:`, e);
    return false;
  }
}
