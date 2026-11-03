/**
 * Host 配置解析 —— **纯函数 + 显式环境**（不在模块加载时读 `process.env`）。
 *
 * 为什么强制显式：Host 会在三种宿主里跑（Windows 桌面 sidecar、Android PRoot、
 * 开发机手跑），环境变量名与默认数据根**各不相同**。把解析写成一个函数，
 * 判据就能对三种宿主各断言一次；写成模块级常量就只能靠真机试。
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface HostConfig {
  /** 数据根（库/日志/附件/溢出/技能都在它下面） */
  dataHome: string;
  /** SQLite 索引文件 */
  dbPath: string;
  /** codem-db-cli 可执行文件（serve 模式） */
  dbBin: string;
  /** 项目根：所有 workspace.* 与工具的文件访问都限制在它里面 */
  workspaceRoot: string;
  /**
   * 工作区是否来自**桌面当前项目**（Phase 1 C：文件与桌面同一份）。
   *
   * 只有桌面 Rust 拉起 Host 时传 `--workspace-shared` 才为 true；Android 本机 Host
   * 与开发机手跑都是 false。手机端据此决定能不能声称"与桌面同一份" ——
   * 不能靠"有 workspaceRoot"推断（Android 的 /opt/app/web 也是工作区）。
   */
  workspaceSharedWithDesktop: boolean;
  /** 监听地址：**永远 loopback**（远程可达性由 Tailscale/Cloudflare 提供，不由我们监听 0.0.0.0） */
  host: string;
  /** 端口；0 = 由内核分配（测试与"同机多实例"必须用 0） */
  port: number;
  /** 静态访问令牌（`CODEM_HOST_TOKEN`，break-glass / CLI 用；不是设备 token） */
  token: string;
  /**
   * 鉴权模式（D-7）：
   * - `local`：loopback（且没有静态 token）免鉴权 —— 开发机 / 旧的 Android PRoot 本机；
   * - `local-auth`：**本机也必须带凭据**。凭据是外壳每次启动随机生成的 64 hex
   *   （`CODEM_HOST_LOCAL_AUTH`），只经环境变量交给 Host，绝不进 argv/日志/URL。
   *   本机页面先带 fragment 引导一次换取 HttpOnly cookie（SSE 用），RPC 用 Bearer；
   * - `paired`：所有人都必须带凭据。**桌面 Host 用这个**：隧道客户端就在本机，
   *   远端请求的 remoteAddress 也是 127.0.0.1，所以"看起来是 loopback"不能作为信任依据。
   */
  authMode: "local" | "local-auth" | "paired";
  /**
   * 本机凭据（`CODEM_HOST_LOCAL_AUTH`）：**每次 Host 启动都不同**，只由本机外壳注入。
   * 只在 `authMode === "local-auth"` 时非空；其它模式恒为空串（避免被误用）。
   */
  localAuthToken: string;
  /**
   * 本机控制令牌（`CODEM_HOST_CONTROL_TOKEN`，由桌面 Rust spawn 时生成并注入）。
   * 只用于 `pair.start/list/revoke` 三个方法；不能用于 `/rpc` 的其它方法、也不能用于 `/events`。
   * CLI 场景可显式给（至少 16 字符），不给则无法在 paired 模式下生成配对码。
   */
  controlToken: string;
  /** 是否允许非 loopback 客户端（默认 false：Host 只服务本机，远程靠隧道） */
  allowRemote: boolean;
  /** 协议版本自报（诊断用） */
  version: string;
}

function defaultDataHome(env: NodeJS.ProcessEnv): string {
  const appId = "com.codem.app";
  if (platform() === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? join(appData, appId) : join(homedir(), "AppData", "Roaming", appId);
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", appId);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg ? join(xdg, appId) : join(homedir(), ".local", "share", appId);
}

/**
 * 定位 `codem-db-cli`。
 *
 * 顺序：显式 `CODEM_DB_BIN` → 随 Host 一起分发的 `bin/`（打包形态）→ 仓库构建产物。
 * **找不到就报错**，不退回"试着用 PATH 里的同名程序"：那是把攻击面与版本漂移
 * 一起请进来（PATH 上的 `codem-db-cli` 可能是任意版本）。
 */
function resolveDbBin(env: NodeJS.ProcessEnv, dataHome: string): string {
  const exe = platform() === "win32" ? "codem-db-cli.exe" : "codem-db-cli";
  const candidates = [
    env.CODEM_DB_BIN?.trim(),
    join(dataHome, "bin", exe),
    join(process.cwd(), "src-tauri", "codem-db", "target", "release", exe),
    join(process.cwd(), "src-tauri", "codem-db", "target", "debug", exe),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error(
    `找不到 codem-db-cli（找过：${candidates.join(" / ")}）。请先 \`npm run db:build\` 或设置 CODEM_DB_BIN`,
  );
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** 命令行显式值优先（高于环境变量） */
  overrides?: Partial<
    Pick<
      HostConfig,
      | "dataHome"
      | "dbPath"
      | "workspaceRoot"
      | "workspaceSharedWithDesktop"
      | "port"
      | "host"
      | "token"
      | "allowRemote"
      | "dbBin"
      | "authMode"
      | "controlToken"
      | "localAuthToken"
    >
  >;
  version?: string;
}

/** 控制令牌最短长度（桌面生成的是 64 hex；手填也不允许短到能猜） */
const MIN_CONTROL_TOKEN_LENGTH = 16;

/** 本机凭据的形态：32 字节随机数的 hex（外壳生成）。固定长度 + 小写，便于判据穷举。 */
const LOCAL_AUTH_TOKEN_RE = /^[0-9a-f]{64}$/;

/** `CODEM_HOST_LOCAL_AUTH` 是否为合法本机凭据 */
export function isLocalAuthToken(value: string): boolean {
  return LOCAL_AUTH_TOKEN_RE.test(value);
}

export function resolveHostConfig(opts: ResolveOptions = {}): HostConfig {
  const env = opts.env ?? process.env;
  const o = opts.overrides ?? {};
  const dataHome = resolve(o.dataHome ?? env.CODEM_DATA_HOME?.trim() ?? defaultDataHome(env));
  // 数据根补齐目录是**调用方**的责任（runtime 一次性建齐），这里只解析路径。
  const dbPath = resolve(o.dbPath ?? env.CODEM_DB_PATH?.trim() ?? join(dataHome, "codem-db-rust.bin"));
  const workspaceRoot = resolve(o.workspaceRoot ?? env.CODEM_WORKSPACE?.trim() ?? process.cwd());
  const workspaceSharedWithDesktop = o.workspaceSharedWithDesktop ?? false;
  const portRaw = o.port ?? Number(env.CODEM_HOST_PORT ?? "0");
  if (!Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    throw new Error(`CODEM_HOST_PORT 不是合法端口：${String(o.port ?? env.CODEM_HOST_PORT)}`);
  }
  const host = o.host ?? env.CODEM_HOST_BIND?.trim() ?? "127.0.0.1";
  const allowRemote = o.allowRemote ?? env.CODEM_HOST_ALLOW_REMOTE === "1";
  const token = o.token ?? env.CODEM_HOST_TOKEN?.trim() ?? "";
  const controlToken = o.controlToken ?? env.CODEM_HOST_CONTROL_TOKEN?.trim() ?? "";
  const rawLocalAuth = o.localAuthToken ?? env.CODEM_HOST_LOCAL_AUTH?.trim() ?? "";
  if (controlToken && controlToken.length < MIN_CONTROL_TOKEN_LENGTH) {
    throw new Error(`CODEM_HOST_CONTROL_TOKEN 至少 ${MIN_CONTROL_TOKEN_LENGTH} 字符（桌面生成 64 位 hex）`);
  }
  const explicitAuth = o.authMode ?? env.CODEM_HOST_AUTH?.trim();
  if (explicitAuth && explicitAuth !== "local" && explicitAuth !== "local-auth" && explicitAuth !== "paired") {
    throw new Error(`CODEM_HOST_AUTH 只能是 local、local-auth 或 paired（收到：${explicitAuth}）`);
  }
  /**
   * 未显式声明时的推导：
   * - 给了本机凭据 ⇒ `local-auth`（外壳只注入这一个变量，不该再要求它声明模式）；
   * - 有控制令牌 ⇒ 桌面/托管形态 ⇒ `paired`（能生成配对码，也必须用凭据）；
   * - 允许远程 ⇒ `paired`（对公网绝不能无鉴权）；
   * - 否则 `local`（开发机与旧 Android PRoot 本机的既有行为）。
   */
  const authMode: HostConfig["authMode"] =
    (explicitAuth as HostConfig["authMode"] | undefined) ??
    (rawLocalAuth ? "local-auth" : allowRemote || controlToken ? "paired" : "local");
  if (authMode === "local-auth") {
    /*
     * 本机凭据的校验**不回显收到的值**：这条错误会进 stderr / host.log，
     * 把用户填错的令牌原样打出来等于把它写进日志。
     */
    if (!isLocalAuthToken(rawLocalAuth)) {
      throw new Error(
        "local-auth 模式需要 CODEM_HOST_LOCAL_AUTH（64 位小写 hex，由本机外壳每次启动生成）",
      );
    }
    if (token) throw new Error("local-auth 不能与 CODEM_HOST_TOKEN 同时使用（两套凭据会让边界说不清）");
    if (controlToken) throw new Error("local-auth 不能与 CODEM_HOST_CONTROL_TOKEN 同时使用");
    if (allowRemote) throw new Error("local-auth 只服务本机，不能与 CODEM_HOST_ALLOW_REMOTE=1 同时使用");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("local-auth 只能绑定 loopback（127.0.0.1 / localhost / ::1）");
    }
  } else if (rawLocalAuth) {
    // 反向混用也拒绝：否则"给了凭据却没启用"会静默变回免鉴权
    throw new Error("CODEM_HOST_LOCAL_AUTH 只能与 CODEM_HOST_AUTH=local-auth 一起使用");
  }
  if (authMode === "paired" && !controlToken && !token) {
    throw new Error(
      "paired 模式缺凭据：请提供 CODEM_HOST_CONTROL_TOKEN（桌面会自动注入）或 CODEM_HOST_TOKEN，否则既无法生成配对码也无法认证任何客户端",
    );
  }
  if (allowRemote && !token && authMode !== "paired") {
    throw new Error("CODEM_HOST_ALLOW_REMOTE=1 时必须提供 CODEM_HOST_TOKEN（不允许无鉴权的对外监听）");
  }
  if (allowRemote && (host === "127.0.0.1" || host === "localhost")) {
    // 不是错误，但要说清：允许远程却只绑回环 = 远程永远连不上（比"静默不可达"更好的是直接说）。
    throw new Error("CODEM_HOST_ALLOW_REMOTE=1 时不能只绑 127.0.0.1：请显式给 CODEM_HOST_BIND");
  }
  return {
    dataHome,
    dbPath,
    dbBin: o.dbBin ?? resolveDbBin(env, dataHome),
    workspaceRoot,
    workspaceSharedWithDesktop,
    host,
    port: portRaw,
    token,
    authMode,
    controlToken,
    localAuthToken: authMode === "local-auth" ? rawLocalAuth : "",
    allowRemote,
    version: opts.version ?? "0.0.0-host-spike",
  };
}

/** Host 自己的运行目录（token / 日志 / 运行记录），与用户会话数据分开。 */
export function hostStateDir(dataHome: string): string {
  return join(dataHome, "host");
}

/** 设备凭据文件（只含 sha256，不含明文 token）；与 `tool-names.json` 同目录。 */
export function pairingFile(dataHome: string): string {
  return join(hostStateDir(dataHome), "pairing.json");
}

/** 便捷：从配置文件路径推导它的目录（测试夹具常用） */
export function dirOf(file: string): string {
  return dirname(resolve(file));
}
