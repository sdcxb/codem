import { getDatabase, persistDatabase } from "./database";
import { runGuarded } from "./write-guard";
import { reportPersistFailure } from "./persist-failure";
import { getStoragePort, hasStoragePort } from "./port";

// ========== 迁移期分流（P3 第 11 段） ==========
//
// 账号表是**典型的小表域**（几条记录），读写都要同步（设置面板直接读）。
// 走通用域镜像：按表加载 → 同步读 → 写穿 + 本地更新。
//
// 路由规则与其它域一致：**只有镜像加载完成后才切换**（读与写必须落在同一处）。
// 未加载完时继续用旧库那份，避免"写进 Rust、读到的还是旧值"。

type AccountDomainPort = {
  domains: {
    isReady(table: string): boolean;
    ensureLoaded(table: string, onLoaded?: () => void): void;
    all<R>(table: string): R[];
    find<R>(table: string, where: Record<string, unknown>): R[];
    findOne<R>(table: string, where: Record<string, unknown>): R | null;
    applyWrite(table: string, row: Record<string, unknown>, primaryKey?: string): void;
    applyDelete(table: string, where: Record<string, unknown>): void;
  };
  data: { execute(cmd: string, params?: Record<string, unknown>): Promise<{ written: number }> };
};

const TABLE = "accounts";

function accountPort(): AccountDomainPort | null {
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  if (port.kind !== "rust") return null;
  const candidate = port as unknown as AccountDomainPort;
  if (!candidate.domains) return null;
  candidate.domains.ensureLoaded(TABLE);
  return candidate.domains.isReady(TABLE) ? candidate : null;
}

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

/** 线协议行 → Account */
function rowToAccountRow(row: Record<string, unknown>): AccountRow {
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

/** 写穿：失败如实上报（不静默吞） */
function writeThrough(cmd: string, params: Record<string, unknown>, note: string): void {
  const port = accountPort();
  if (!port) return;
  void port.data.execute(cmd, params).catch((e) => {
    reportPersistFailure(`account.${cmd}`, e, note);
  });
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
  const port = accountPort();
  if (port) {
    // 与旧实现的排序一致：updated_at DESC
    return port.domains
      .all<Record<string, unknown>>(TABLE)
      .map(rowToAccountRow)
      .map(rowToAccount)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts ORDER BY updated_at DESC");
  if (result.length === 0) return [];
  return result[0].values.map(rowToAccountFromAny);
}

export function getAccount(id: string): Account | null {
  const port = accountPort();
  if (port) {
    const row = port.domains.findOne<Record<string, unknown>>(TABLE, { id });
    return row ? rowToAccount(rowToAccountRow(row)) : null;
  }
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToAccountFromAny(result[0].values[0]);
}

export function getActiveAccount(): Account | null {
  const port = accountPort();
  if (port) {
    const row = port.domains.findOne<Record<string, unknown>>(TABLE, { is_active: 1 });
    return row ? rowToAccount(rowToAccountRow(row)) : null;
  }
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts WHERE is_active = 1 LIMIT 1");
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToAccountFromAny(result[0].values[0]);
}

export function createAccount(account: Account): void {
  const port = accountPort();
  if (port) {
    // upsert 语义（存在则覆盖），一次写穿 + 本地更新
    const row = accountToRow(account);
    port.domains.applyWrite(TABLE, row);
    writeThrough("crud.upsert", { table: TABLE, rows: [row], mode: "replace" }, "账号未保存");
    return;
  }
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
  const routed = accountPort();
  if (routed) {
    const current = routed.domains.findOne<Record<string, unknown>>(TABLE, { id });
    if (current) {
      const merged = rowToAccountRow({ ...current, ...accountToRow({ ...rowToAccount(rowToAccountRow(current)), ...update, id } as Account) });
      routed.domains.applyWrite(TABLE, merged as unknown as Record<string, unknown>);
      writeThrough("crud.upsert", { table: TABLE, rows: [merged], mode: "replace" }, "账号改动未保存");
      return;
    }
    // 镜像里没有这条：不猜数据，回退旧路径（旧路径的 runGuarded 会记 A 类问题）
  }
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
  const port = accountPort();
  if (port) {
    port.domains.applyDelete(TABLE, { id });
    writeThrough("crud.delete", { table: TABLE, where: { id } }, "账号未删除，重启后会恢复");
    return;
  }
  const db = getDatabase();
  db.run("DELETE FROM accounts WHERE id = ?", [id]);
  persistDatabase();
}

/**
 * 设为当前账号。
 *
 * ⚠️ 这是本域**唯一有业务语义**的写操作：必须"先清空所有 is_active，再置位目标"，
 * 而且要在**一个事务**里完成 —— 否则中断会留下"没有当前账号"或"多个当前账号"。
 * 通用命令表达不了这个语义，所以旧路径用两条语句（第二句走 runGuarded），
 * Rust 路径则逐行 upsert（每行一个事务，但不一致窗口只有毫秒级且幂等可重放）。
 */
export function setActiveAccount(id: string): void {
  const port = accountPort();
  if (port) {
    const now = Date.now();
    const all = port.domains.all<Record<string, unknown>>(TABLE);
    const rows = all.map((row) => {
      const isTarget = row.id === id;
      const next = { ...row, is_active: isTarget ? 1 : 0, ...(isTarget ? { updated_at: now } : {}) };
      port.domains.applyWrite(TABLE, next);
      return next;
    });
    // 目标账号可能不在镜像里（例如刚创建但镜像尚未刷新）——那样就不动它，等下次加载
    writeThrough(
      "crud.upsert",
      { table: TABLE, rows, mode: "replace" },
      "当前账号未切换（重启后可能回到旧账号）",
    );
    return;
  }
  const db = getDatabase();
  db.run("UPDATE accounts SET is_active = 0");
  runGuarded(db, "UPDATE accounts SET is_active = 1, updated_at = ? WHERE id = ?", [Date.now(), id],
    { table: "accounts", op: "activate", id, from: "activateAccount" });
  persistDatabase();
}