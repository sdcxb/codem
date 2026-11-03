/**
 * Android 连接页的**源码不变量**（DPAIR-AND-*，D-7）。
 *
 * 真机行为无法在 vitest 里跑；这里只守不能靠人工记住的规则：
 * - 原生页不再输入/拼接访问令牌（旧实现的 `?token=` 会进 WebView 历史与 logcat）；
 * - 任何 URL 日志都先经过 `safeUrlForLog`（剥掉 query）；
 * - 旧 prefs 里的 `remote_token` 被清理，而不是继续读取；
 * - 设备凭据改成 HttpOnly cookie 后，WebView 必须在 onPause 落盘，且不能清 cookie。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("android-shell/src/com/codem/remote/MainActivity.java", "utf8");

describe("DPAIR-AND-1 连接页不再拼 token", () => {
  it("没有访问令牌输入框，也没有把 token 拼进 URL", () => {
    expect(SRC).not.toContain('field("访问令牌');
    expect(SRC).not.toContain('putString("remote_token"');
    expect(SRC).not.toContain('+ "token="');
    expect(SRC).not.toContain("URLEncoder.encode(token");
  });

  it("旧 prefs 的 remote_token 会被清除", () => {
    expect(SRC).toContain('prefs().contains("remote_token")');
    expect(SRC).toContain('remove("remote_token")');
  });
});

describe("DPAIR-AND-3 设备 cookie 落盘", () => {
  it("onPause 调 CookieManager.flush()（WebView 进程被杀前唯一可靠的落盘点）", () => {
    expect(SRC).toContain("import android.webkit.CookieManager;");
    const start = SRC.indexOf("protected void onPause()");
    expect(start).toBeGreaterThan(0);
    const body = SRC.slice(start, start + 800);
    expect(body).toContain("super.onPause()");
    expect(body).toContain("flushCookies()");
    expect(SRC).toContain("CookieManager.getInstance().flush()");
  });
});

describe("DPAIR-AND-4 不破坏 cookie 持久化", () => {
  it("没有 removeAllCookies / setAcceptCookie(false) 调用", () => {
    // 任何"清理 cookie"的调用都会把 HttpOnly 设备凭据一起删掉 ⇒ 每次重启都要重配
    expect(SRC).not.toContain("removeAllCookies(");
    expect(SRC).not.toContain("setAcceptCookie(");
    expect(SRC).not.toContain("setAcceptThirdPartyCookies(");
  });
});

describe("DPAIR-AND-2 URL 日志不含 query", () => {
  it("openOnlyWebView / takeUrlIntent 只打印 safeUrlForLog", () => {
    expect(SRC).toContain('Log.i(TAG, "loading " + safeUrlForLog(url))');
    expect(SRC).not.toContain('"loading " + url)');
    expect(SRC).toContain('"takeUrlIntent url=" + (url == null ? "null" : safeUrlForLog(url))');
    expect(SRC).not.toContain('"takeUrlIntent url=" + url');
  });

  it("safeUrlForLog 不拼接 query", () => {
    const start = SRC.indexOf("private static String safeUrlForLog");
    expect(start).toBeGreaterThan(0);
    const body = SRC.slice(start, start + 900);
    expect(body).not.toContain("getQuery");
    expect(body).not.toContain("getRawQuery");
    expect(body).toContain("u.getPath()");
  });
});
