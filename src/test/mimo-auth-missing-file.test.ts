/**
 * 走查唯一一条 console error 的回归判据：
 *
 * > `[MiMoAuth] Failed to load auth.json: Cannot read C:\Users\…\.local\share\mimocode\auth.json:
 * >  系统找不到指定的路径。 (os error 3)`
 *
 * 结论（与代码一致，见 `src/core/auth/mimo.ts` 与 `src-tauri/src/lib.rs` 的 `mimo_read_auth`）：
 * **本机没登录 MiMo 账号时 auth.json 本来就不存在 ⇒ 这是正常态，不是故障**。
 * auth.json 只有 `mimo_login`（原生 OAuth 成功）才会写；"未登录"时应用本来就该走设置里的 API Key。
 * 所以它必须**在正常路径上如实留日志（不许静默）但不进 error 级**；
 * 只有权限不足 / JSON 损坏这类真故障才保留 error。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MiMoAuth, isAuthFileMissing } from "../core/auth/mimo";

const MISSING_MSG =
  "Cannot read C:\\Users\\abee\\.local\\share\\mimocode\\auth.json: 系统找不到指定的路径。 (os error 3)";

function setInvoke(impl: (cmd: string, args?: unknown) => Promise<unknown>) {
  (window as any).__TAURI__ = { core: { invoke: impl } };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  delete (window as any).__TAURI__;
});

describe("MiMoAuth：auth.json 缺失是正常态（未登录 MiMo 账号）", () => {
  it("M1 后端返回 { exists: false } ⇒ 走正常路径日志，且不产生 console.error", async () => {
    setInvoke(async () => ({ exists: false }));
    const account = await new MiMoAuth().loadFromAuthJson();
    expect(account).toBeNull();
    expect(errorSpy, "未登录不是故障，不许报 error").not.toHaveBeenCalled();
    expect(logSpy, "未登录要在正常路径上留下如实说明（不许静默）").toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain("auth.json");
    expect(line).toContain("API key"); // 如实说明"没有该文件 ⇒ 走设置里的 API key"
  });

  it("M2 老版后端抛 os error 3（文件/目录不存在）⇒ 同样不进 error（版本错配兜底）", async () => {
    setInvoke(async () => {
      throw new Error(MISSING_MSG);
    });
    expect(isAuthFileMissing(new Error(MISSING_MSG))).toBe(true);
    const account = await new MiMoAuth().loadFromAuthJson();
    expect(account).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("M3 真故障（权限不足 / JSON 损坏）仍然必须是 error 级", async () => {
    setInvoke(async () => {
      throw new Error("Cannot read C:\\…\\auth.json: 拒绝访问。 (os error 5)");
    });
    expect(isAuthFileMissing(new Error("Cannot read x: 拒绝访问。 (os error 5)"))).toBe(false);
    const account = await new MiMoAuth().loadFromAuthJson();
    expect(account).toBeNull();
    expect(errorSpy, "真故障不许被降级成正常路径日志").toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("[MiMoAuth] Failed to load auth.json");
  });

  it("M4 读到凭据时照常返回账号（正常路径没被改成一律返回 null）", async () => {
    setInvoke(async () => ({
      exists: true,
      xiaomi: { key: "k-123456", metadata: { uid: "u1", base_url: "https://api.xiaomimimo.com/v1" } },
    }));
    const account = await new MiMoAuth().loadFromAuthJson();
    expect(account).not.toBeNull();
    expect(account!.id).toBe("mimo-u1");
    expect(account!.accessToken).toBe("k-123456");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("M5 读到文件但没有 key（未登录/空凭据）⇒ 不报错，也不算故障", async () => {
    setInvoke(async () => ({ exists: true, xiaomi: {} }));
    const account = await new MiMoAuth().loadFromAuthJson();
    expect(account).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
