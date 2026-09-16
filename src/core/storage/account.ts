import { getDatabase, persistDatabase } from "./database";
import { runGuarded } from "./write-guard";
import { shouldFallbackToLegacy, writeShouldFallBackToLegacy, domainDelete, domainPort, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

// ========== 迁移期分流（P3 第 11/12 段） ==========
//
// 账号表是**典型的小表域**（几条记录），读写都要同步（设置面板直接读）。
// 走通用域镜像：按表加载 → 同步读 → 写穿 + 本地更新。
//
// 骨架（加载判定、写穿上报、超限回退）都在 `domain-store.ts`：
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

function rowToAccountFromAny(row: any[]): Account {
  return rowToAccount({
    id: row[0] as string,
    email: row[1] as string,
    url: row[2] as string,
    access_token: row[3] as string,
    refresh_token: row[4] as string | null,
    token_expiry: row[5] as number | null,
    org_id: row[6] as string | null,
    is_active: row[7] as number,
    created_at: row[8] as number,
    updated_at: row[9] as number,
  });
}

export function listAccounts(): Account[] {
  const rust = domainReadMany(TABLE, (row) => rowToAccount(wireToRow(row)));
  if (rust) {
    // 与旧实现的排序一致：updated_at DESC
    return rust.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  if (!shouldFallbackToLegacy()) return [];
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts ORDER BY updated_at DESC");
  if (result.length === 0) return [];
  return result[0].values.map(rowToAccountFromAny);
}

export function getAccount(id: string): Account | null {
  const rust = domainReadOne(TABLE, { id }, (row) => rowToAccount(wireToRow(row)));
  if (rust !== undefined) return rust;
  if (!shouldFallbackToLegacy()) return null;
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToAccountFromAny(result[0].values[0]);
}

export function getActiveAccount(): Account | null {
  const rust = domainReadOne(TABLE, { is_active: 1 }, (row) => rowToAccount(wireToRow(row)));
  if (rust !== undefined) return rust;
  if (!shouldFallbackToLegacy()) return null;
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts WHERE is_active = 1 LIMIT 1");
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToAccountFromAny(result[0].values[0]);
}

export function createAccount(account: Account): void {
  if (domainWrite(TABLE, [accountToRow(account)], { mode: "replace", scope: "account.create", note: "账号未保存" })) {
    return;
  }
  // 两态：A 态才回退旧库；B 态已如实上报
  if (!writeShouldFallBackToLegacy("account.save", "账号未保存，重启后会恢复")) return;
  const db = getDatabase();
  const existing = db.exec("SELECT id FROM accounts WHERE id = ?", [account.id]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    updateAccount(account.id, {
      email: account.email,
      url: account.url,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      tokenExpiry: account.tokenExpiry,
      orgId: account.orgId,
      isActive: account.isActive,
    });
    return;
  }
  db.run(
    `INSERT INTO accounts (id, email, url, access_token, refresh_token, token_expiry, org_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      account.id,
      account.email,
      account.url,
      account.accessToken,
      account.refreshToken ?? null,
      account.tokenExpiry ?? null,
      account.orgId ?? null,
      account.isActive ? 1 : 0,
      account.createdAt,
      account.updatedAt,
    ]
  );
  persistDatabase();
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
  // 未接手 / 镜像里没有这条：先判两态（B 态不碰旧库，由 runGuarded 的记账取代静默）
  if (!writeShouldFallBackToLegacy("account.update", "账号未更新，重启后会恢复")) return;
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.email !== undefined) { fields.push("email = ?"); values.push(update.email); }
  if (update.url !== undefined) { fields.push("url = ?"); values.push(update.url); }
  if (update.accessToken !== undefined) { fields.push("access_token = ?"); values.push(update.accessToken); }
  if (update.refreshToken !== undefined) { fields.push("refresh_token = ?"); values.push(update.refreshToken ?? null); }
  if (update.tokenExpiry !== undefined) { fields.push("token_expiry = ?"); values.push(update.tokenExpiry ?? null); }
  if (update.orgId !== undefined) { fields.push("org_id = ?"); values.push(update.orgId ?? null); }
  if (update.isActive !== undefined) { fields.push("is_active = ?"); values.push(update.isActive ? 1 : 0); }
  fields.push("updated_at = ?");
  values.push(Date.now());

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[account.ts] update 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }
  values.push(id);
  runGuarded(
    db,
    `UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`,
    values,
    { table: "accounts", op: "update", id, from: "updateAccount" },
  );
  persistDatabase();
}

export function deleteAccount(id: string): void {
  if (domainDelete(TABLE, { id }, { scope: "account.delete", note: "账号未删除，重启后会恢复" })) return;
  if (!writeShouldFallBackToLegacy("account.delete", "账号未删除，重启后会恢复")) return;
  const db = getDatabase();
  db.run("DELETE FROM accounts WHERE id = ?", [id]);
  persistDatabase();
}

/**
 * 设为当前账号。
 *
 * ⚠️ 这是本域**唯一有业务语义**的写操作：必须"先清空所有 is_active，再置位目标"。
 * 通用命令表达不了这个语义，所以这里显式算出**全部行**的新状态一次性写回
 * （Rust 路径逐行 upsert；旧路径用两条语句，第二句走 runGuarded）。
 * 不变量（恰好一个 active）由 DOM-6 守住。
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
  if (!writeShouldFallBackToLegacy("account.activate", "当前账号未切换，重启后会恢复")) return;
  const db = getDatabase();
  db.run("UPDATE accounts SET is_active = 0");
  runGuarded(db, "UPDATE accounts SET is_active = 1, updated_at = ? WHERE id = ?", [Date.now(), id],
    { table: "accounts", op: "activate", id, from: "activateAccount" });
  persistDatabase();
}
