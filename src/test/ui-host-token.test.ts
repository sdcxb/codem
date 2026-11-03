/**
 * Host 令牌的客户端判据（TOK-1..3）：
 * - 地址栏里的 `?token=` **只删不读**：不写 localStorage、不返回（设备凭据已改 HttpOnly cookie）；
 * - 本地存储只服务**历史静态令牌**：仍能读出旧值，并能被清理；UI 不再写入新值；
 * - 没有令牌时返回空串（loopback 免鉴权 / cookie 场景）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { clearHostToken, resolveHostToken, stripLegacyTokenFromUrl } from "../../packages/ui/src/transport";

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("TOK-1 URL 里的旧 token 只删不读", () => {
  it("抹掉 token= 保留其它参数；不持久化、也不作为令牌返回", () => {
    window.history.replaceState(null, "", "/?token=legacy-device-token&open=s1");
    stripLegacyTokenFromUrl();
    expect(window.location.search).not.toContain("token=");
    expect(window.location.search).toContain("open=s1");
    // 关键：不吸收 —— 设备凭据只在 HttpOnly cookie 里，JS 不应该再存一份
    expect(localStorage.getItem("codem.hostToken")).toBeNull();
    expect(resolveHostToken()).toBe("");
  });

  it("没有 token 参数时是空操作（不破坏其它 query）", () => {
    window.history.replaceState(null, "", "/?open=s1");
    stripLegacyTokenFromUrl();
    expect(window.location.search).toBe("?open=s1");
  });
});

describe("TOK-2 本地持久值只服务历史静态令牌", () => {
  it("没有 URL 参数时返回 localStorage 的值", () => {
    localStorage.setItem("codem.hostToken", "stored-static");
    expect(resolveHostToken()).toBe("stored-static");
  });

  it("升级前留下的静态令牌可以被清理", () => {
    localStorage.setItem("codem.hostToken", "legacy-static");
    clearHostToken();
    expect(localStorage.getItem("codem.hostToken")).toBeNull();
    expect(resolveHostToken()).toBe("");
  });
});

describe("TOK-3 都没有时返回空串", () => {
  it("localStorage 为空 ⇒ 空串（cookie / loopback 场景）", () => {
    expect(resolveHostToken()).toBe("");
  });
});
