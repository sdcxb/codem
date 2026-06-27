import { getDatabase, persistDatabase } from "./database";

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
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts ORDER BY updated_at DESC");
  if (result.length === 0) return [];
  return result[0].values.map(rowToAccountFromAny);
}

export function getAccount(id: string): Account | null {
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToAccountFromAny(result[0].values[0]);
}

export function getActiveAccount(): Account | null {
  const db = getDatabase();
  const result = db.exec("SELECT * FROM accounts WHERE is_active = 1 LIMIT 1");
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToAccountFromAny(result[0].values[0]);
}

export function createAccount(account: Account): void {
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

  if (fields.length === 0) return;
  values.push(id);
  db.run(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteAccount(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM accounts WHERE id = ?", [id]);
  persistDatabase();
}

export function setActiveAccount(id: string): void {
  const db = getDatabase();
  db.run("UPDATE accounts SET is_active = 0");
  db.run("UPDATE accounts SET is_active = 1, updated_at = ? WHERE id = ?", [Date.now(), id]);
  persistDatabase();
}
