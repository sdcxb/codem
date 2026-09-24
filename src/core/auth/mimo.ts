import * as AccountStorage from "../storage/account";
import type { Account } from "../storage/account";

async function tauriInvoke(cmd: string, args?: Record<string, any>): Promise<any> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke(cmd, args);
}

export interface LoginResult {
  success: boolean;
  api_key?: string;
  error?: string;
}

/**
 * `mimo_read_auth` 的返回形状（Rust 侧 `src-tauri/src/lib.rs` 的 `mimo_read_auth`）。
 *
 * - `{ exists: false }` —— **没登录过 MiMo 账号**。auth.json 只有 `mimo_login`（原生 OAuth
 *   成功后）才会写，所以"文件不存在"是**正常态**，不是故障。
 * - `{ exists: true, xiaomi: {...} }` —— 读到了凭据。
 */
interface AuthJsonFile {
  exists?: boolean;
  xiaomi?: {
    key?: string;
    metadata?: { uid?: string; base_url?: string };
    [k: string]: unknown;
  };
  /** 老版 Rust（返回形状里没有 `exists`）读不到文件时抛的是 os error 3/2 —— 由错误文本兜底判定 */
  [k: string]: unknown;
}

/**
 * 从错误对象里判断"失败原因是不是**文件不存在**"。
 *
 * 为什么要兜底字符串：Rust 侧老版本只在出错时给一句 `Cannot read <path>: <系统错误 (os error 3)>`，
 * 而 `os error 2`/`os error 3` 是 **ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND**，
 * 两者都表示"这个文件本来就不存在"（`~/.local/share/mimocode/` 目录都没建过）。
 * 新版 Rust 已改为走正常的 `{ exists: false }` 返回；这里保留兜底是为了
 * 应用与后端版本错配时不会把"没登录"误报成故障。
 *
 * 注意：**权限不足、JSON 损坏等真故障不在这个判定里**，它们仍然按 error 级上报。
 */
export function isAuthFileMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg) return false;
  if (/os error (2|3)\b/.test(msg)) return true;
  return /(系统找不到指定的文件|系统找不到指定的路径|The system cannot find the file|The system cannot find the path|No such file or directory)/i.test(msg);
}

export class MiMoAuth {
  async loadFromAuthJson(): Promise<Account | null> {
    try {
      const auth = (await tauriInvoke("mimo_read_auth")) as AuthJsonFile | null;
      // 正常态：本机没登录 MiMo 账号 ⇒ auth.json 不存在。
      // 这里**不报错**（"没登录"不是故障），但要留下可查的日志：未登录时走设置里的 API Key。
      if (auth && auth.exists === false) {
        console.log(
          "[MiMoAuth] 本机没有 auth.json（未登录 MiMo 账号），这是正常形态：将走设置里的 API key 鉴权。",
        );
        return null;
      }
      if (!auth?.xiaomi?.key) return null;

      const uid = auth.xiaomi.metadata?.uid || "default";
      const accountId = `mimo-${uid}`;
      const account: Account = {
        id: accountId,
        email: `MiMo User (${uid})`,
        url: auth.xiaomi.metadata?.base_url || "https://api.xiaomimimo.com/v1",
        accessToken: auth.xiaomi.key,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Check if this exact account already exists and is active
      const existing = AccountStorage.getActiveAccount();
      if (existing && existing.id === accountId && existing.accessToken === account.accessToken) {
        return existing;
      }

      // Deactivate other accounts, then save this one
      for (const acc of AccountStorage.listAccounts()) {
        if (acc.isActive && acc.id !== accountId) {
          AccountStorage.updateAccount(acc.id, { isActive: false });
        }
      }

      // Use createAccount (handles upsert now)
      AccountStorage.createAccount(account);
      return account;
    } catch (e) {
      // 兜底：与"没有 exists 字段"的老版 Rust 后端错配时，缺文件仍然报的是 os error 2/3。
      // 它同样表示"没登录过"，属于正常态 ⇒ 日志如实说明，不进 error。
      if (isAuthFileMissing(e)) {
        console.log(
          "[MiMoAuth] 本机没有 auth.json（未登录 MiMo 账号），这是正常形态：将走设置里的 API key 鉴权。",
          e,
        );
        return null;
      }
      // 真故障（权限不足 / JSON 损坏 / 读不动）才保留 error 级
      console.error("[MiMoAuth] Failed to load auth.json:", e);
      return null;
    }
  }

  async login(): Promise<LoginResult> {
    try {
      // First check if auth.json already exists
      const existing = await this.loadFromAuthJson();
      if (existing) {
        return { success: true, api_key: existing.accessToken };
      }

      // Run mimo providers login via Tauri command
      const result = await tauriInvoke("mimo_login");
      if (result?.success && result?.auth?.xiaomi?.key) {
        const account = await this.loadFromAuthJson();
        if (account) {
          return { success: true, api_key: account.accessToken };
        }
      }
      return { success: false, error: "Login failed" };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  getActiveAccount(): Account | null {
    return AccountStorage.getActiveAccount();
  }

  async getValidToken(account: Account): Promise<string | null> {
    return account.accessToken;
  }

  logout(accountId: string): void {
    AccountStorage.deleteAccount(accountId);
  }
}

let authInstance: MiMoAuth | null = null;
export function getMiMoAuth(): MiMoAuth {
  if (!authInstance) authInstance = new MiMoAuth();
  return authInstance;
}
