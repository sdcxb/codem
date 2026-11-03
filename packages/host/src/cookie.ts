/**
 * 设备凭据的 Cookie 编解码 —— **纯函数**：无 I/O、无日志、不读 `process.env`。
 *
 * ## 为什么设备 token 改成 HttpOnly cookie
 *
 * 之前 `pair.claim` 把 64 hex 的设备 token 放进 JSON，客户端存 localStorage、请求带
 * `Authorization: Bearer`，SSE 因为 EventSource 不能带 header 只能拼 `?token=`。
 * 于是凭据对页面 JS 可读、还会进 URL（WebView 历史 / 代理日志 / 诊断快照）。
 * 现在 token 只经 `Set-Cookie` 下发、只经 cookie 回传：同源请求（含 EventSource）
 * 自动携带，页面 JS 读不到。
 *
 * ## 名字为什么不是 `hostId`
 *
 * `hostId` 是数据根路径的**末 8 位 hex**；桌面数据根恒为 `...\com.codem.app\host`，
 * 末 4 字节就是字符串 `host` ⇒ 所有桌面安装都算出同一个 `host-686f7374`。
 * cookie 不按端口隔离（RFC 6265 §8.5），同源不同端口的两个 Host 就会互相覆盖同名 cookie。
 * 这里用 `sha256(resolve(dataHome))` 的前 16 位：数据根不变则名字稳定，且不同数据根必不相同。
 *
 * ## 属性
 *
 * - `Path=/`：Host 同时服务页面与 `/rpc`、`/events`；
 * - `HttpOnly`：页面 JS 不可读（本文件只生成属性串，不提供读取 cookie 的浏览器侧接口）；
 * - `SameSite=Strict`：跨站请求不带（配合服务器保留的 `Origin` 校验）；
 * - `Max-Age`：**必须显式给**，否则是会话 cookie，WebView/浏览器进程结束就丢；
 * - `Secure`：**只在有 HTTPS 证据时**加。Host 自身只监听 http，LAN/本机都是明文 http，
 *   无条件加 `Secure` 会让浏览器直接丢掉刚收到的 cookie ⇒ 永远 401；
 * - 不加 `Domain`（host-only）、不用 `__Host-`/`__Secure-`（两者都要求无条件 `Secure`）。
 *
 * ## 本机凭据为什么也走 cookie
 *
 * `local-auth` 模式下页面能拿到本机凭据（URL fragment 引导一次），但 **SSE 不能带 header**，
 * EventSource 也拿不到 JS 里的 token。若沿用"`?token=`"就等于把每次启动的凭据放进 URL
 * （WebView 历史 / 诊断 / 代理日志）。所以只多做一步：用 Bearer 调一次 `/local-auth`，
 * 换一个 HttpOnly cookie —— 之后的 `/events` 靠同源 cookie 自动携带，RPC 仍用 Bearer。
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";

/** cookie 名前缀；完整名字见 `deviceCookieName()` */
export const DEVICE_COOKIE_PREFIX = "codem_device_";

/**
 * 本机（local-auth）cookie 名前缀。
 *
 * 与设备 cookie 分开命名是必须的：`local-auth` 模式下设备 cookie 一律不认
 * （否则旧的 400 天设备凭据会绕过"每次启动轮换"），共用名字会让清理互相踩。
 */
export const LOCAL_AUTH_COOKIE_PREFIX = "codem_local_";

/**
 * 本机 cookie 的有效期：12 小时。
 *
 * 它的值每次 Host 启动都会变（外壳新生成），所以有效期只需要覆盖一次前台使用；
 * 给太长只会让"旧启动的凭据"在浏览器里躺得更久（虽然服务端已经不认它）。
 */
export const LOCAL_AUTH_COOKIE_MAX_AGE_SEC = 12 * 60 * 60;

/**
 * 400 天。Chrome M104 起把超过 400 天的 `Max-Age` 截到 400 天（不是拒绝），
 * 所以直接给上限值，避免"设了 10 年却被静默截断"的误判。
 */
export const DEVICE_COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60;

/** 名字里固定 16 位 hex（64 bit）；足够避免碰撞，又不会让 Cookie 头变长。 */
const NAME_HASH_CHARS = 16;

/**
 * 设备 cookie 名：`codem_device_` + `sha256(resolve(dataHome))` 前 16 位。
 *
 * 稳定性要求来自"重配要覆盖旧 cookie"：名字随设备/端口变化就会留下一条永不失效的
 * 残值；唯一性要求来自同机多 Host（cookie 无端口隔离）。两个都满足才叫"稳定且唯一"。
 */
export function deviceCookieName(dataHome: string): string {
  const digest = createHash("sha256").update(resolve(dataHome), "utf8").digest("hex");
  return `${DEVICE_COOKIE_PREFIX}${digest.slice(0, NAME_HASH_CHARS)}`;
}

/**
 * 本机 cookie 名：`codem_local_` + `sha256(resolve(dataHome))` 前 16 位。
 *
 * 稳定性理由与设备 cookie 相同（重启要覆盖旧值而不是堆一条永不失效的残值）；
 * 兼容性上额外要求：即使同一台机器上同时跑着桌面 Host 与手机壳 Host，
 * 两个名字也不能撞（数据根不同 ⇒ 哈希不同）。
 */
export function localAuthCookieName(dataHome: string): string {
  const digest = createHash("sha256").update(resolve(dataHome), "utf8").digest("hex");
  return `${LOCAL_AUTH_COOKIE_PREFIX}${digest.slice(0, NAME_HASH_CHARS)}`;
}

export interface DeviceCookieOptions {
  /** `deviceCookieName(dataHome)` 的结果 */
  name: string;
  /** 明文设备 token（64 hex）；只进 `Set-Cookie`，不落日志 */
  token: string;
  /** 请求确实来自 HTTPS 才为 true（见 `isHttpsRequest()`） */
  secure: boolean;
  /** 覆盖有效期（判据用；缺省 400 天） */
  maxAgeSec?: number;
}

/** 序列化实现（设备与本机两种 cookie 的属性完全相同，只有名字/有效期不同）。 */
function serializeCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  // 属性顺序固定（名字=值 → Path → HttpOnly → SameSite → Max-Age → [Secure]），
  // 判据按子串断言，顺序变化不影响语义，但固定顺序能让抓包对比更容易。
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * 生成设备 `Set-Cookie` 值。
 */
export function serializeDeviceCookie(opts: DeviceCookieOptions): string {
  return serializeCookie(opts.name, opts.token, opts.maxAgeSec ?? DEVICE_COOKIE_MAX_AGE_SEC, opts.secure);
}

/**
 * 生成本机（`/local-auth`）的 `Set-Cookie` 值。
 *
 * 值就是本次启动的本机凭据：它已经在 URL fragment 里出现过一次（引导用），
 * 之后只经 cookie / Bearer 头回传，不再进 URL。
 */
export function serializeLocalAuthCookie(opts: {
  name: string;
  token: string;
  secure: boolean;
  maxAgeSec?: number;
}): string {
  return serializeCookie(
    opts.name,
    opts.token,
    opts.maxAgeSec ?? LOCAL_AUTH_COOKIE_MAX_AGE_SEC,
    opts.secure,
  );
}

/**
 * 删除同名 cookie（`Max-Age=0`）。
 *
 * 用途：撤销/失效后的 401 响应里带回它，让浏览器把已经无效的凭据清掉 ——
 * HttpOnly cookie 页面 JS 删不了，只能由服务端删。
 */
export function clearDeviceCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** 删除本机 cookie（Host 重启后旧凭据必然失效；页面带着它只会一直 401）。 */
export function clearLocalAuthCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * 解析 `Cookie` 请求头。
 *
 * 宽容是必须的：浏览器、WebView、代理给出的格式可能带多余空格或空段；
 * 解析失败**不能**抛错（那会让一个畸形头变成 500）。同名取第一次出现（先到先得），
 * 后面的重复项不覆盖 —— 追加的同名 cookie 不能改写前面的凭据。
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = value;
  }
  return out;
}

/** 从请求里取指定 cookie；没有/为空返回空串（调用方不需要区分两种"没有"）。 */
export function requestCookie(req: Pick<IncomingMessage, "headers">, name: string): string {
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header.join("; ") : header;
  return parseCookieHeader(raw)[name] ?? "";
}

/**
 * 这次请求是否来自 HTTPS —— Host 自己是 http，只能看代理/浏览器给的信号。
 *
 * 判定顺序：
 * 1. `X-Forwarded-Proto`（Tailscale serve/funnel 会带；取第一个值，可能是 `https, http`）；
 * 2. 没有 XFP 时看 `Origin`（浏览器对 POST 会带；`Origin: null` 当作没有信号）。
 *
 * 误判成 Secure 只会让浏览器丢掉自己刚收到的 cookie（自伤，不会让 http 客户端拿到凭据）；
 * 漏判只影响 Secure 加固，不影响可用性。所以这里不需要部署开关。
 */
export function isHttpsRequest(req: Pick<IncomingMessage, "headers">): boolean {
  const xfp = req.headers["x-forwarded-proto"];
  const raw = Array.isArray(xfp) ? xfp[0] : (xfp ?? "");
  const first = raw.split(",")[0].trim().toLowerCase();
  if (first) return first === "https";

  const origin = req.headers.origin;
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}
