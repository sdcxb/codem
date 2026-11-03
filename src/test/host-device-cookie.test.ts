// @vitest-environment node
/**
 * 设备 cookie 的纯函数判据（DC-1..DC-5）。
 *
 * 这一层没有 HTTP、没有 PairingService：名字/属性/解析/HTTPS 判定都可以单测穷举。
 * 行为级判据（claim 下发、cookie 认证、撤销）在 `host-authz.test.ts` 的 AUTHZ-*。
 */
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEVICE_COOKIE_MAX_AGE_SEC,
  clearDeviceCookie,
  deviceCookieName,
  isHttpsRequest,
  parseCookieHeader,
  requestCookie,
  serializeDeviceCookie,
} from "../../packages/host/src/cookie";

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("DC-1 命名：稳定、唯一、字符集安全", () => {
  it("同一数据根 → 同一名字（重配要覆盖而不是新增）", () => {
    const dataHome = join("data", "codem", "host");
    expect(deviceCookieName(dataHome)).toBe(deviceCookieName(`${dataHome}/`));
    expect(deviceCookieName(dataHome)).toMatch(/^codem_device_[0-9a-f]{16}$/);
  });

  it("两个都以 /host 结尾的数据根 → 名字不同（hostId 会在这里退化）", () => {
    // 这是真实退化形态：hostId = "host-" + hex(dataHome).slice(-8)，而 hex 的末尾
    // 4 字节恒为 "host" ⇒ 所有桌面安装都算成 host-686f7374。cookie 名必须用全路径哈希。
    const pathA = join("data", "desktop-a", "host");
    const pathB = join("data", "desktop-b", "host");
    expect(pathA.endsWith("host")).toBe(true);
    expect(pathB.endsWith("host")).toBe(true);
    expect(deviceCookieName(pathA)).not.toBe(deviceCookieName(pathB));
  });

  it("名字是合法的 cookie-name（无空格/分号/逗号）", () => {
    expect(deviceCookieName(join("data", "x"))).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe("DC-2 序列化属性", () => {
  const name = "codem_device_0123456789abcdef";
  const token = "a".repeat(64);

  it("默认带 Path=/、HttpOnly、SameSite=Strict、Max-Age=400 天；http 下没有 Secure", () => {
    const value = serializeDeviceCookie({ name, token, secure: false });
    expect(value).toBe(
      `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${400 * 24 * 60 * 60}`,
    );
    expect(value).not.toContain("Secure");
    expect(value).not.toContain("Domain=");
    expect(DEVICE_COOKIE_MAX_AGE_SEC).toBe(34_560_000);
  });

  it("HTTPS 证据存在时才加 Secure", () => {
    expect(serializeDeviceCookie({ name, token, secure: true })).toContain("; Secure");
  });

  it("Max-Age 可覆盖（判据用），删除头是 Max-Age=0 且不带值", () => {
    expect(serializeDeviceCookie({ name, token, secure: false, maxAgeSec: 60 })).toContain("Max-Age=60");
    const cleared = clearDeviceCookie(name);
    expect(cleared).toBe(`${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(cleared).not.toContain(token);
  });
});

describe("DC-3 解析 Cookie 头", () => {
  it("多 cookie、空白、非法段都不抛错", () => {
    const parsed = parseCookieHeader(" a=1 ; b=two ;;; c ; =x ; d= ; e=5 ");
    expect(parsed).toEqual({ a: "1", b: "two", e: "5" });
  });

  it("同名取第一次出现（追加的同名 cookie 不能覆盖前面的凭据）", () => {
    expect(parseCookieHeader("k=first; k=second")).toEqual({ k: "first" });
  });

  it("requestCookie 支持字符串头与数组头；缺失时返回空串", () => {
    expect(requestCookie(req({ cookie: "x=1; y=2" }), "y")).toBe("2");
    expect(requestCookie(req({ cookie: ["x=1", "y=2"] }), "y")).toBe("2");
    expect(requestCookie(req({}), "y")).toBe("");
    expect(requestCookie(req({ cookie: "y=" }), "y")).toBe("");
  });
});

describe("DC-4 HTTPS 判定（决定要不要 Secure）", () => {
  it("X-Forwarded-Proto 第一个值是 https 才算", () => {
    expect(isHttpsRequest(req({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(isHttpsRequest(req({ "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(isHttpsRequest(req({ "x-forwarded-proto": "http" }))).toBe(false);
    // XFP 存在时它是权威信号：即使 Origin 是 https 也不推翻（代理已把 scheme 说清楚了）
    expect(isHttpsRequest(req({ "x-forwarded-proto": "http", origin: "https://host" }))).toBe(false);
  });

  it("没有 XFP 时用 Origin 兜底；null/非法/缺失都当无信号", () => {
    expect(isHttpsRequest(req({ origin: "https://host" }))).toBe(true);
    expect(isHttpsRequest(req({ origin: "http://host" }))).toBe(false);
    expect(isHttpsRequest(req({ origin: "null" }))).toBe(false);
    expect(isHttpsRequest(req({ origin: "not a url" }))).toBe(false);
    expect(isHttpsRequest(req({}))).toBe(false);
  });
});

describe("DC-5 不夹带其它秘密", () => {
  const token = "b".repeat(64);
  const name = deviceCookieName(join("data", "secret-check"));

  it("名字与删除头都不含 token，序列化只出现一次明文值", () => {
    expect(name).not.toContain(token);
    expect(clearDeviceCookie(name)).not.toContain(token);
    const value = serializeDeviceCookie({ name, token, secure: true });
    expect(value.split(token)).toHaveLength(2);
    expect(value).not.toContain("tokenHash");
    expect(value).not.toContain("SameSite=None");
  });
});
