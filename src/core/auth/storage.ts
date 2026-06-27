import { getDatabase, persistDatabase } from "../storage/database";

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

function rowToAccount(row: any[]): Account {
  return {
    id: row[0] as string,
    email: row[1] as string,
    url: row[2] as string,
    accessToken: row[3] as string,
    refreshToken: row[4] as string | undefined,
    tokenExpiry: row[5] as number | undefined,
    orgId: row[6] as string | undefined,
    isActive: (row[7] as number) === 1,
    createdAt: row[8] as number,
    updatedAt: row[9] as number,
  };
}

export function listAccounts(): Account[] {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM accounts ORDER BY updated_at DESC");
    if (result.length === 0) return [];
    return result[0].values.map(rowToAccount);
  } catch { return []; }
}

export function getAccount(id: string): Account | null {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM accounts WHERE id = ?", [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToAccount(result[0].values[0]);
  } catch { return null; }
}

export function getActiveAccount(): Account | null {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM accounts WHERE is_active = 1 LIMIT 1");
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToAccount(result[0].values[0]);
  } catch { return null; }
}

export function createAccount(account: Account): void {
  const db = getDatabase();
  db.run(
    "INSERT INTO accounts (id, email, url, access_token, refresh_token, token_expiry, org_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [account.id, account.email, account.url, account.accessToken, account.refreshToken ?? null, account.tokenExpiry ?? null, account.orgId ?? null, account.isActive ? 1 : 0, account.createdAt, account.updatedAt]
  );
  persistDatabase();
}

export function updateAccount(id: string, update: Partial<Account>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (update.email !== undefined) { fields.push("email = ?"); values.push(update.email); }
  if (update.accessToken !== undefined) { fields.push("access_token = ?"); values.push(update.accessToken); }
  if (update.refreshToken !== undefined) { fields.push("refresh_token = ?"); values.push(update.refreshToken ?? null); }
  if (update.tokenExpiry !== undefined) { fields.push("token_expiry = ?"); values.push(update.tokenExpiry ?? null); }
  if (update.isActive !== undefined) { fields.push("is_active = ?"); values.push(update.isActive ? 1 : 0); }
  fields.push("updated_at = ?"); values.push(Date.now());
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
