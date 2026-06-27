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
      console.log("[MiMoAuth] loadFromAuthJson: calling mimo_read_auth...");
      const auth = await tauriInvoke("mimo_read_auth");
      console.log("[MiMoAuth] loadFromAuthJson: auth =", auth);

      if (!auth) {
        console.error("[MiMoAuth] loadFromAuthJson: auth is null");
        return null;
      }
      if (!auth.xiaomi) {
        console.error("[MiMoAuth] loadFromAuthJson: auth.xiaomi is null");
        return null;
      }
      if (!auth.xiaomi.key) {
        console.error("[MiMoAuth] loadFromAuthJson: auth.xiaomi.key is null");
        return null;
      }

      const uid = auth.xiaomi.metadata?.uid || "default";
      const accountId = `mimo-${uid}`;
      console.log("[MiMoAuth] loadFromAuthJson: accountId =", accountId);

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
      console.log("[MiMoAuth] loadFromAuthJson: existing active =", existing?.id);

      if (existing && existing.id === accountId && existing.accessToken === account.accessToken) {
        console.log("[MiMoAuth] loadFromAuthJson: returning existing account");
        return existing;
      }

      // Deactivate other accounts
      const allAccounts = AccountStorage.listAccounts();
      console.log("[MiMoAuth] loadFromAuthJson: total accounts =", allAccounts.length);
      for (const acc of allAccounts) {
        if (acc.isActive && acc.id !== accountId) {
          console.log("[MiMoAuth] loadFromAuthJson: deactivating", acc.id);
          AccountStorage.updateAccount(acc.id, { isActive: false });
        }
      }

      // Save account
      console.log("[MiMoAuth] loadFromAuthJson: creating account...");
      AccountStorage.createAccount(account);
      console.log("[MiMoAuth] loadFromAuthJson: account created, returning");

      return account;
    } catch (e) {
      console.error("[MiMoAuth] loadFromAuthJson FAILED:", e);
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

  async logout(accountId: string): Promise<void> {
    AccountStorage.deleteAccount(accountId);
    // Also delete auth.json from disk
    try {
      await tauriInvoke("mimo_delete_auth");
    } catch {}
  }
}

let authInstance: MiMoAuth | null = null;
export function getMiMoAuth(): MiMoAuth {
  if (!authInstance) authInstance = new MiMoAuth();
  return authInstance;
}
