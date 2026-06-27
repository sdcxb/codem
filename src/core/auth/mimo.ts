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

export class MiMoAuth {
  async loadFromAuthJson(): Promise<Account | null> {
    try {
      const auth = await tauriInvoke("mimo_read_auth");
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
