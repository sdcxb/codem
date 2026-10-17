/**
 * 真实浏览器探针（BROWSER-PROBE）—— 用 **CDP** 取 fixture 算出来的 `PROBE_JSON`。
 *
 * ## 为什么不再用 `--dump-dom`
 *
 * 这两条契约（首屏底色 / 设置弹窗几何）必须用**真浏览器**测：jsdom 没有布局引擎，
 * 量不出「设置窗塌成 160px」这类事。原来的做法是
 * `msedge --headless=new --dump-dom <fixture>` 再正则抠 DOM 里的 `PROBE_JSON=`。
 *
 * 2026-10-17 真机取证发现这台 Windows 上**一次性无头输出这条路是哑的**：
 * `--dump-dom` / `--screenshot` / `--print-to-pdf` 三个开关都 exit 0、跑约 1 秒、
 * profile 真的写盘，但 stdout 与 stderr **都是 0 字节**（两个已安装 Edge 版本、
 * 独立 `--user-data-dir`、bash 管道 / node 管道 / PowerShell 重定向全都一样）。
 * 而同一个 Edge 的**浏览器本体完全正常**：`--headless=new --remote-debugging-port`
 * 能起来，用 CDP 打开同一份 fixture 能拿到一模一样的 `PROBE_JSON`
 * （取证：`docs/evidence/browser-probe-cdp-2026-10-17/`）。
 *
 * ⇒ 坏的是「跑一次、把结果打到 stdout」这条通道，不是引擎。所以这里换成
 * **CDP**：起一次无头浏览器 → 用 `Emulation.setDeviceMetricsOverride` 定视口 →
 * `Page.navigate` → 轮询 `Runtime.evaluate` 读探针元素。**断言与契约一字不改**，
 * 换的只是"怎么把结果取回来"。
 *
 * ## 为什么视口走 Emulation 而不是 `--window-size`
 *
 * 实测 `--window-size` 在无头 Edge 里**不生效**（传 1200,800 时 fixture 量到的
 * `innerWidth` 仍是 500）—— 而 `LAYOUT-0` 断言 `viewport.h > 500`，
 * 靠 `--window-size` 会变成一条**恒假**的判据。`Emulation.setDeviceMetricsOverride`
 * 是协议层覆盖，`innerWidth/innerHeight/matchMedia` 都跟着它走，确定性更好。
 *
 * ## 约定
 *
 * - 端口用 `--remote-debugging-port=0` + profile 里的 `DevToolsActivePort` 文件：
 *   vitest 并行跑多个测试文件，固定端口会互相踩。
 * - 只杀**自己 spawn 的那个 pid 树**（`taskkill /PID <pid> /T /F`），绝不按映像名杀。
 * - 探针拿不到 `PROBE_JSON` 时**抛错**（而不是返回空对象）：那意味着传输或 fixture 坏了，
 *   必须让判据变红，而不是让"空结果"静默通过。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { get as httpGet } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Chromium 系浏览器的候选路径（Windows 优先 Edge，再 Chrome；其它平台留两个通用名） */
const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChromiumBrowser(): string | null {
  for (const c of BROWSER_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

export interface BrowserProbeOptions {
  /** fixture 的绝对路径 */
  fixture: string;
  /** 追加到 file:// URL 后面的查询串（如 `?cache=dark`） */
  query?: string;
  /** 视口尺寸（走 `Emulation.setDeviceMetricsOverride`） */
  viewport?: [number, number];
  /** 探针元素选择器（默认 `#probe-out, #probe`：两个 fixture 用的 id 不同） */
  selector?: string;
  /** 等 `PROBE_JSON` 出现的上限 */
  timeoutMs?: number;
  /** 覆盖浏览器路径（测试可以传自己找到的那个） */
  browserPath?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到 fn 返回真值；超时抛错（把最后一次异常带上，避免"超时"两个字断案） */
async function pollUntil<T>(fn: () => Promise<T | null> | T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await sleep(100);
  }
  const suffix = lastError ? `；最后一次异常：${(lastError as Error)?.message ?? String(lastError)}` : "";
  throw new Error(`浏览器探针超时（${timeoutMs}ms）：${what}${suffix}`);
}

/**
 * HTTP GET → JSON。**不用 `fetch`**：测试环境是 happy-dom，它的 fetch 会按同源策略
 * 拒绝 `127.0.0.1:<随机端口>`（实测报 "Cross-Origin Request Blocked"），
 * 而 CDP 的 `/json/list` 本来就不需要浏览器语义 —— 直接用 node:http 取。
 */
function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("HTTP 超时")));
  });
}

/** 杀掉自己 spawn 的 pid 树（Windows 用 taskkill /T；其它平台交给 kill） */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* 已经退出 */
  }
}

/** 同步等一会儿：用 Atomics.wait，别起子进程（起一次 `ping` 要 ~1 秒，重试几次就是十几秒） */
function sleepSync(ms: number): void {
  const guard = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(guard, 0, 0, ms);
}

/** 删临时 profile（Windows 上文件句柄可能晚一点释放，所以带几次重试；总上限约 1 秒） */
function removeProfile(dir: string): void {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 句柄还没释放：等一下再试
      sleepSync(100);
    }
  }
}

/** 读 `DevToolsActivePort`（第一行是端口）；文件还没写就返回 null */
function readActivePort(profileDir: string): number | null {
  const file = join(profileDir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  try {
    const first = readFileSync(file, "utf8").split(/\r?\n/)[0]?.trim() ?? "";
    const port = Number.parseInt(first, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

/** 一次浏览器会话里可复用的发送函数 */
type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<any>;

/**
 * 起一个无头浏览器，把 `send` 交给回调，结束后**只杀自己 spawn 的那棵进程树**。
 *
 * 为什么一个会话要跑多个 probe：每次冷启动无头浏览器 ~2-4 秒（而且要和别的
 * vitest worker 抢磁盘），一个文件里连开三次会把全量跑拖慢十几秒、还会让别的
 * 计时敏感用例在满载下超时。同一份 profile 里换页即可，隔离靠 `about:blank` 兜住。
 */
async function withCdpSession<T>(browserPath: string, timeoutMs: number, fn: (send: CdpSend) => Promise<T>): Promise<T> {
  const profileDir = mkdtempSync(join(tmpdir(), "codem-probe-"));
  let child: ChildProcess | null = null;
  let ws: WebSocket | null = null;
  try {
    child = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );

    const spawnError = new Promise<never>((_, reject) => {
      child!.once("error", (e) => reject(new Error(`浏览器启动失败：${e.message}`)));
    });

    const port = await Promise.race([
      pollUntil(() => readActivePort(profileDir), timeoutMs, "等浏览器把 DevToolsActivePort 写出来"),
      spawnError,
    ]);

    const target = await pollUntil(async () => {
      const list = (await httpGetJson(`http://127.0.0.1:${port}/json/list`)) as CdpTarget[];
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
    }, timeoutMs, "等一个可控的 page target");

    ws = new WebSocket(target.webSocketDebuggerUrl as string);
    const socket = ws;
    let seq = 0;
    const pending = new Map<number, (msg: any) => void>();
    socket.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    const send: CdpSend = (method, params = {}) =>
      new Promise<any>((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });

    await send("Page.enable");
    await send("Runtime.enable");
    return await fn(send);
  } finally {
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
    if (child) killTree(child);
    removeProfile(profileDir);
  }
}

/** 一次 probe：先回 about:blank（防止读到上一次 probe 留下的元素文本），再定视口、导航、等 PROBE_JSON */
async function probeOnce<T>(send: CdpSend, options: BrowserProbeOptions): Promise<T> {
  const [width, height] = options.viewport ?? [1200, 800];
  const selector = options.selector ?? "#probe-out, #probe";
  const timeoutMs = options.timeoutMs ?? 20_000;
  const url = "file:///" + options.fixture.split("\\").join("/") + (options.query ?? "");

  await send("Page.navigate", { url: "about:blank" });
  await pollUntil(async () => {
    const res = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    return res?.result?.result?.value === "about:blank" ? true : null;
  }, timeoutMs, "回到空白页（清掉上一次 probe 的 DOM）");

  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });

  const text = await pollUntil(async () => {
    const res = await send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : ""; })()`,
      returnByValue: true,
    });
    const value = res?.result?.result?.value;
    return typeof value === "string" && value.startsWith("PROBE_JSON=") ? value : null;
  }, timeoutMs, `等 fixture 写出 PROBE_JSON（${url}）`);

  const json = text.slice("PROBE_JSON=".length);
  try {
    return JSON.parse(json) as T;
  } catch (e) {
    throw new Error(`PROBE_JSON 不是合法 JSON（${(e as Error).message}）：${json.slice(0, 160)}`);
  }
}

/**
 * 在**同一个**浏览器里依次跑多个 probe（返回顺序与入参一致）。
 *
 * 断言语义与逐个起浏览器完全一样：每份 fixture 都是独立文档、视口各自覆盖。
 */
export async function readFixtureProbes<T>(list: BrowserProbeOptions[], browserPath?: string): Promise<T[]> {
  const resolved = browserPath ?? findChromiumBrowser();
  if (!resolved) {
    throw new Error("没有找到 Chromium 系浏览器（msedge / chrome）—— 本机无法做真实渲染契约");
  }
  const timeoutMs = Math.max(...list.map((o) => o.timeoutMs ?? 20_000));
  return withCdpSession(resolved, timeoutMs, async (send) => {
    const out: T[] = [];
    for (const options of list) out.push(await probeOnce<T>(send, options));
    return out;
  });
}
