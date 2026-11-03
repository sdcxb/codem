#!/usr/bin/env node
/**
 * `codem-host` 入口。
 *
 * 用法：
 *   node host.mjs serve --data-home <dir> --workspace <dir> [--workspace-shared] [--port 0] [--print-port]
 *
 * 为什么入口这么"素"：Host 要能被 Tauri 当 sidecar 拉起（stderr 进日志、stdout 报一行
 * READY），也要能在 Android PRoot 里由前台服务拉起（同样的两件事）。任何花哨的
 * 交互式 CLI 都会破坏这两个宿主。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostConfig, pairingFile } from "./config";
import { readLlmConfigFromStdin, takeLlmConfigFromEnv } from "./llm-config";
import { PairingService } from "./pairing";
import { HostRuntime } from "./runtime";
import { startHostServer } from "./server";
import { installTauriCompat } from "./tauri-compat";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      booleans.add(key);
    }
  }
  return { command: rest[0] ?? "serve", flags, booleans };
}

async function main(): Promise<void> {
  /*
   * **stdout 是协议通道**（只允许那行 READY），所以把 `console.log` 改道到 stderr。
   *
   * 这不是洁癖：渲染侧那套 core 里有大量 `console.log`（`[runAgenticLoop]` 等），
   * 一旦它们写进 stdout，拉起方（Tauri sidecar / Android 前台服务）解析到的就是
   * 半行 JSON / 夹杂文本 —— 症状是"Host 起来了但连不上"，而日志里看不出原因。
   */
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const args = parseArgs(process.argv.slice(2));
  if (args.command === "--help" || args.command === "help") {
    process.stdout.write(
      "codem-host serve --data-home <dir> --workspace <dir> [--workspace-shared] [--db <file>] [--port 0] [--print-port] [--llm-stdin]\n",
    );
    return;
  }
  const config = resolveHostConfig({
    overrides: {
      ...(args.flags.has("data-home") ? { dataHome: resolve(args.flags.get("data-home") as string) } : {}),
      ...(args.flags.has("db") ? { dbPath: resolve(args.flags.get("db") as string) } : {}),
      ...(args.flags.has("workspace") ? { workspaceRoot: resolve(args.flags.get("workspace") as string) } : {}),
      // 只有桌面 Rust 会传：声明"这个工作区是桌面当前项目"（Phase 1 C）。
      ...(args.booleans.has("workspace-shared") ? { workspaceSharedWithDesktop: true } : {}),
      ...(args.flags.has("port") ? { port: Number(args.flags.get("port")) } : {}),
      ...(args.flags.has("token") ? { token: args.flags.get("token") as string } : {}),
    },
    version: process.env.CODEM_HOST_VERSION ?? "0.0.0-host-spike",
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = args.flags.has("web") ? resolve(args.flags.get("web") as string) : join(here, "..", "web");

  /*
   * local 模式 = loopback 免鉴权（开发机 / 旧的 Android PRoot 本机）。
   * 它**不能**用来对外：隧道客户端就在本机，remoteAddress 也是 127.0.0.1。
   * 这里只打一句非秘密提示，不猜用户有没有开隧道。
   */
  if (config.authMode === "local") {
    process.stderr.write(
      "[host] 本机免鉴权模式（local）。若要经 Tailscale/Cloudflare 对外，请设置 CODEM_HOST_AUTH=paired（或 CODEM_HOST_TOKEN）。\n",
    );
  }
  if (config.authMode === "local-auth") {
    // 只说"已启用"，**不说任何值**：这一行进 host.log / adb logcat 都不会带凭据。
    process.stderr.write(
      "[host] 本机鉴权模式（local-auth）：RPC 与事件流都必须带本次启动的本机凭据（由外壳注入）。\n",
    );
  }

  /*
   * 凭据只用于**配置解析**：解析完就从 `process.env` 删掉。
   *
   * 为什么必须删：Host 会为工具调用 spawn 子进程（bash/git/…）并继承环境变量。
   * 控制令牌/本机凭据若留在环境里，一个被提示词带偏的命令（`env`/`printenv`）就能把它原样读走，
   * 而它足以调用整个 /rpc 面 —— 等于把"本机控制面"交给模型。
   * （execve 的初始 environ 块删不掉，这是已知残余面：与桌面控制令牌同一现状。）
   */
  delete process.env.CODEM_HOST_CONTROL_TOKEN;
  delete process.env.CODEM_HOST_TOKEN;
  delete process.env.CODEM_HOST_LOCAL_AUTH;

  /*
   * 模型配置同理，而且更敏感：API Key 一旦被子进程继承，模型跑一次 `env` 就能把它
   * 打进工具输出（→ 会话消息 / 截图 / 导出）。两条路径：
   * - `--llm-stdin`（Android 外壳用）：Key 从不进入进程环境，`/proc/<pid>/environ` 干净；
   * - 环境变量（开发机/判据）：解析完立刻删。
   *
   * 注意顺序：必须在 `HostRuntime.create`（会拉起 `codem-db` 子进程）**之前**解析，
   * 否则第一个子进程就已经继承了 Key。
   */
  const useStdin = args.booleans.has("llm-stdin");
  // stdin 失败**直接抛**（不回落 env）：否则"以为用了新 Key 其实用了旧环境变量"
  const fromStdin = useStdin ? await readLlmConfigFromStdin(process.stdin) : null;
  // 无条件清环境：即使走 stdin，也不许环境里留副本给未来的子进程
  const fromEnv = takeLlmConfigFromEnv(process.env);
  const llm = fromStdin ?? fromEnv;

  // 先装 IPC 兼容层，再让存储/工具去碰文件（两者都是"调用时读全局"，顺序只需在调用前）
  installTauriCompat({
    dataHome: config.dataHome,
    dbPath: config.dbPath,
    workspaceRoot: config.workspaceRoot,
  });

  const runtime = await HostRuntime.create(config, { llm });
  let pairing: PairingService;
  try {
    pairing = await PairingService.open({ filePath: pairingFile(config.dataHome) });
  } catch (e) {
    await runtime.close();
    throw e;
  }
  const server = await startHostServer({ config, runtime, webDir, pairing }).catch(async (e: unknown) => {
    await pairing.close();
    await runtime.close();
    throw e;
  });
  // stdout 只留这一行给拉起方解析；其余诊断一律 stderr（与 codem-db serve 同一纪律）
  process.stdout.write(`${JSON.stringify({ ready: true, url: server.url, port: server.port, hostId: runtime.hostId })}\n`);
  if (args.booleans.has("print-port")) process.stderr.write(`[host] listening ${server.url}\n`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[host] ${signal} → 关闭\n`);
    try {
      await server.close();
    } finally {
      try {
        await pairing.close();
      } finally {
        await runtime.close();
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    process.stderr.write(`[host] uncaught: ${e?.stack ?? String(e)}\n`);
  });
  process.on("unhandledRejection", (e) => {
    process.stderr.write(`[host] unhandled rejection: ${String(e)}\n`);
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly || process.env.CODEM_HOST_FORCE_MAIN === "1") {
  void main().catch((e: unknown) => {
    process.stderr.write(`[host] 启动失败：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
