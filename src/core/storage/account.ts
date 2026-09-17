import { reportPersistFailure } from "./persist-failure";
import { domainDelete, domainPort, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

// ========== 迁移期分流（P3 第 11/12 段） ==========
//
// 账号表是**典型的小表域**（几条记录），读写都要同步（设置面板直接读）。
// 走通用域镜像：按表加载 → 同步读 → 写穿 + 本地更新。
//
// 骨架（加载判定、写穿上报、超限放弃镜像）都在 `domain-store.ts`：
// 本文件只负责"行 shape 转换"与业务语义（`setActiveAccount` 的不变量）。

const TABLE = "accounts";

/** Account → 线协议行（snake_case，与 Rust 契约一致） */
function accountToRow(a: Account): Record<string, unknown> {
  return {
    id: a.id,
    email: a.email,
    url: a.url,
    access_token: a.accessToken,
    refresh_token: a.refreshToken ?? null,
    token_expiry: a.tokenExpiry ?? null,
    org_id: a.orgId ?? null,
    is_active: a.isActive ? 1 : 0,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

/** 线协议行 → AccountRow */
function wireToRow(row: Record<string, unknown>): AccountRow {
  return {
    id: String(row.id ?? ""),
    email: String(row.email ?? ""),
    url: String(row.url ?? ""),
    access_token: String(row.access_token ?? ""),
    refresh_token: (row.refresh_token as string | null) ?? null,
    token_expiry: (row.token_expiry as number | null) ?? null,
    org_id: (row.org_id as string | null) ?? null,
    is_active: Number(row.is_active ?? 0),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

export interface Account {
  id: string;
  email: string;
  url: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: number;
  orgId?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AccountRow {
  id: string;
  email: string;
  url: string;
  access_token: string;
  refresh_token: string | null;
  token_expiry: number | null;
  org_id: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    url: row.url,
    accessToken: row.access_token,
    refreshToken: row.refresh_token ?? undefined,
    tokenExpiry: row.token_expiry ?? undefined,
    orgId: row.org_id ?? undefined,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(): Account[] {
  const rust = domainReadMany(TABLE, (row) => rowToAccount(wireToRow(row)));
  if (rust) {
    // 与旧实现的排序一致：updated_at DESC
    return rust.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
  // （旧库已从渲染进程移除，读不到就是读不到）
  return [];
}

export function getAccount(id: string): Account | null {
  const rust = domainReadOne(TABLE, { id }, (row) => rowToAccount(wireToRow(row)));
  if (rust !== undefined) return rust;
  // **旧库回退已删除**（L4 第 18 轮）：端口没接手时如实返回"查不到"
  return null;
}

export function getActiveAccount(): Account | null {
  const rust = domainReadOne(TABLE, { is_active: 1 }, (row) => rowToAccount(wireToRow(row)));
  if (rust !== undefined) return rust;
  // **旧库回退已删除**（L4 第 18 轮）：端口没接手时如实返回"没有当前账号"
  return null;
}

export function createAccount(account: Account): void {
  if (domainWrite(TABLE, [accountToRow(account)], { mode: "replace", scope: "account.create", note: "账号未保存" })) {
    return;
  }
  /**
   * **旧库写入已删除**（L4 第 18 轮）。
   *
   * 原实现在端口没接手时会去旧库先查重、再 INSERT/UPDATE —— 而 rust 模式下旧库
   * 刻意不存在，那条路要么抛错、要么写进一份读路径看不见的副本（本进程内读写分裂）。
   * 现在**如实上报**：账号没保存，重启后不会"恢复"成用户以为的样子。
   */
  reportPersistFailure(
    "account.save",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "账号未保存，重启后会恢复",
  );
}

export function updateAccount(id: string, update: Partial<Account>): void {
  // 迁移期：更新是把"当前完整行 + 本次改动"整体 upsert（与消息索引同一条思路）——
  // 通用命令没有"只改部分列"的参数化形态，而传完整行语义等价且更安全（不会漏列）。
  const current = domainReadOne(TABLE, { id }, (row) => rowToAccount(wireToRow(row)));
  if (current) {
    const merged = { ...current, ...update, id };
    if (domainWrite(TABLE, [accountToRow(merged)], { mode: "replace", scope: "account.update", note: "账号改动未保存" })) {
      return;
    }
  }
  /**
   * **旧库更新已删除**（L4 第 18 轮）：端口没接手（或镜像里没有这一行）时**如实上报**。
   * 绝不静默当成更新成功 —— 那正是 B 类假成功。
   */
  reportPersistFailure(
    "account.update",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "账号未更新，重启后会恢复",
  );
}

export function deleteAccount(id: string): void {
  if (domainDelete(TABLE, { id }, { scope: "account.delete", note: "账号未删除，重启后会恢复" })) return;
  // **旧库删除已删除**（L4 第 18 轮）：端口没接手时如实上报，绝不静默当成删成功
  reportPersistFailure(
    "account.delete",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "账号未删除，重启后会恢复",
  );
}

/**
 * 设为当前账号。
 *
 * ⚠️ 这是本域**唯一有业务语义**的写操作：必须"先清空所有 is_active，再置位目标"。
 * 通用命令表达不了这个语义，所以这里显式算出**全部行**的新状态一次性写回
 * （逐行 upsert）。不变量（恰好一个 active）由 DOM-6 守住。
 *
 * L4 第 18 轮：原来"端口没接手 → 旧库两条 UPDATE"的回退已删除，
 * 端口没接手时改为**如实上报**（切换没生效，而不是静默装作切好了）。
 */
export function setActiveAccount(id: string): void {
  const port = domainPort(TABLE);
  if (port) {
    const now = Date.now();
    const rows = port.domains.all<Record<string, unknown>>(TABLE).map((row) => ({
      ...row,
      is_active: row.id === id ? 1 : 0,
      ...(row.id === id ? { updated_at: now } : {}),
    }));
    domainWrite(TABLE, rows, { mode: "replace", scope: "account.activate", note: "当前账号未切换（重启后可能回到旧账号）" });
    return;
  }
  reportPersistFailure(
    "account.activate",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "当前账号未切换，重启后会恢复",
  );
}
