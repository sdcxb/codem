/**
 * MCP 连接生命周期：**连接中途被断开 / 被替换**（第 181 波，对标 Pi `8c911797c`）。
 *
 * ## 缺陷形态（真机可观察）
 *
 * `connect()` 里有三个 `await`（spawn → initialize 握手 → tools/list），每个都可能是秒级。
 * 用户在这段时间里点「断开」或删掉服务器（`MCPRegistry.removeServer` **不 await** 就调
 * `disconnect`）时，旧实现只把 Map 里的条目删掉：
 *
 * 1. **子进程孤儿**：`mcp_stdio_connect` 是**先 spawn 再握手**，所以走到这里时 Rust 侧
 *    进程已经在跑了。旧代码把进程句柄从 `mcp_processes` 里摘掉却没人杀 ⇒ 退出 Codem 后
 *    还能看到那个 `npx`/`node` 进程赖着。
 * 2. **状态自相矛盾**：`connect()` 的 `await` 一旦返回，它会继续把 `status = "connected"`
 *    写回**那个已经被删掉的**连接对象 ⇒ 日志/界面出现"已断开但状态是已连接"。
 *
 * ## 判据（全部落在公开方法可观测的事实上）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | MCP-L1 | stdio 服务器卡在 `initialize` 时 `disconnect` | 恰好一次 `mcp_stdio_disconnect`；不写回 connected |
 * | MCP-L2 | `removeServer`（**不 await** disconnect）+ 卡住的连接 | 进程必须被收掉 |
 * | MCP-L3 | 同名服务器已重连、旧连接才结算 | 旧连接不许污染新连接（状态与工具都要完好） |
 * | MCP-L4 | 反向对照：没被断开时正常连接 | `connected` + 工具齐，且**先 tools/list 后 connected** |
 * | MCP-L5 | 卡在 `tools/list`（握手已过）时断开 | 同样收进程、同样不写回 connected |
 *
 * ## 造法要点（第一版踩过两个坑，都记在这里）
 *
 * ①**按 JSON-RPC 方法名分派**（`initialize` / `tools/list`），不按调用序号 ——
 *   同名服务器连两次时，"第 1 次请求"不能代表"第一次连接"。
 * ②**闸门按"最近一次连接"归属**：`initialize` 等的是该名字**最后一枚**闸门，
 *   而闸门 promise 是**首次被等待时才创建**。于是"第一次连接"卡住、"第二次连接"
 *   拿到一枚尚未创建的闸门（等价于已放行），测试可以精确地只让第一次结算。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MCPClient, MCPRegistry } from "../core/mcp/mcp";

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2024-11-05", serverInfo: { name: "demo", version: "1.0.0" }, capabilities: {} },
});

function toolsOk(names: string[]) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { tools: names.map((n) => ({ name: n, description: n, inputSchema: { type: "object" } })) },
  });
}

function methodOf(message: unknown): string {
  try {
    return String((JSON.parse(String(message)) as { method?: string })?.method ?? "");
  } catch {
    return "";
  }
}

/**
 * 握手闸门：按**"这是第几次连接"**归属（不是"第几次 initialize"）。
 *
 * 为什么必须按连接归属：同一个服务器名连两次时，两次 `initialize` 在方法层长得一模一样，
 * 只有"第几次 `connect()`"才是要区分的那个事实。测试先 `claim(attempt)` 认领要堵住的那一次，
 * 其余连接自动获得**已放行**的闸门（`waitIfClaimed` 返回 `undefined`）。
 */
function handshakeGates() {
  const gates = new Map<number, { promise: Promise<void>; open: () => void }>();
  return {
    /** 认领并堵住第 `attempt` 次连接（0-based）；重复调用返回同一枚 */
    claim(attempt: number): Promise<void> {
      const existing = gates.get(attempt);
      if (existing) return existing.promise;
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      gates.set(attempt, { promise, open: () => release() });
      return promise;
    },
    /** 第 `attempt` 次连接要不要等 —— 只等被 `claim` 认领过的那些 */
    waitIfClaimed(attempt: number): Promise<void> | undefined {
      return gates.get(attempt)?.promise;
    },
    open(attempt: number) {
      gates.get(attempt)?.open();
    },
    openAll() {
      for (const g of gates.values()) g.open();
    },
  };
}

interface HarnessOptions {
  /** `(名字, 这是第几次连接, 这是第几次 initialize)` */
  beforeInitialize?: (name: string, attempt: number, nth: number) => Promise<void> | undefined;
  beforeToolsList?: (name: string, nth: number) => Promise<void> | undefined;
  initialize?: (name: string, nth: number) => string;
  toolsList?: (name: string, nth: number) => string;
}

/** 一个"能精确控制时序"的 Tauri 桩；`calls` 用来断言 IPC 次数 */
function installMcpHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  let attempt = -1;
  let initializeCount = 0;
  let toolsListCount = 0;
  return {
    calls,
    countOf: (cmd: string) => calls.filter((c) => c === cmd).length,
    /** 每次调 `connect()` 之前调一次，让桩知道"这是第几次连接" */
    beginAttempt: () => ++attempt,
    install() {
      (globalThis as any).window = globalThis.window ?? ({} as any);
      (window as any).__TAURI__ = {
        core: {
          invoke: async (cmd: string, args: any) => {
            calls.push(cmd);
            if (cmd === "mcp_stdio_connect") return undefined;
            if (cmd === "mcp_stdio_disconnect") return undefined;
            if (cmd === "mcp_stdio_request") {
              const name = String(args.name);
              const method = methodOf(args.message);
              if (method === "initialize") {
                const nth = initializeCount++;
                await options.beforeInitialize?.(name, attempt, nth);
                return options.initialize?.(name, nth) ?? INIT_OK;
              }
              if (method === "tools/list") {
                const nth = toolsListCount++;
                await options.beforeToolsList?.(name, nth);
                return options.toolsList?.(name, nth) ?? toolsOk(["t_search"]);
              }
              throw new Error(`test harness: unexpected method "${method}"`);
            }
            throw new Error(`test harness: unexpected command "${cmd}"`);
          },
        },
      };
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete (window as any).__TAURI__;
});


describe("MCP 连接生命周期竞态（第 181 波）", () => {
  it("MCP-L1: 卡在 initialize 时断开 → 收掉子进程恰好一次，且不许写回 connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gates = handshakeGates();
    gates.claim(0); // 堵住第 1 次连接
    const harness = installMcpHarness({
      beforeInitialize: (_name, attempt) => gates.waitIfClaimed(attempt),
    });
    harness.install();

    const client = new MCPClient();
    harness.beginAttempt();
    const connecting = client.connect({ name: "slow", transport: "stdio", command: "npx" });
    await Promise.resolve(); // 让 connect 走到 initialize 的 await

    await client.disconnect("slow");
    expect(
      harness.countOf("mcp_stdio_disconnect"),
      "断开时必须真的去收 Rust 侧的 stdio 进程 —— 否则它就是孤儿",
    ).toBe(1);

    gates.open(0);
    const conn = await connecting;

    expect(conn.status, "连接过程已被断开 ⇒ 这次连接必须按「已取消」结束").toBe("disconnected");
    expect(client.getStatus("slow"), "断开的服务器不许重新出现在连接表里").toBeUndefined();
    expect(client.getAllTools(), "被断开的服务器不贡献任何工具").toHaveLength(0);
    expect(
      harness.countOf("mcp_stdio_disconnect"),
      "收进程只许一次：disconnect 已经收过，过期结算不该再收一遍（重复 IPC）",
    ).toBe(1);
    warn.mockRestore();
  });

  it("MCP-L2: removeServer（不 await disconnect）也要把进程收掉", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gates = handshakeGates();
    gates.claim(0);
    const harness = installMcpHarness({
      beforeInitialize: (_name, attempt) => gates.waitIfClaimed(attempt),
    });
    harness.install();

    const registry = new MCPRegistry();
    harness.beginAttempt();
    const connecting = registry.connect({ name: "removable", transport: "stdio", command: "npx" });
    await Promise.resolve();

    registry.removeServer("removable");
    await new Promise((r) => setTimeout(r, 0)); // removeServer 内部是 fire-and-forget

    expect(
      harness.countOf("mcp_stdio_disconnect"),
      "删掉服务器必须收掉它的进程（旧实现只删 Map 条目）",
    ).toBe(1);

    gates.openAll();
    const status = await connecting;
    expect(status.connected, "被删掉的服务器不许报告已连接").toBe(false);
    warn.mockRestore();
  });

  it("MCP-L3: 同名服务器已重连、旧连接才结算 → 旧连接不许污染新连接", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gates = handshakeGates();
    gates.claim(0); // 只堵第一次连接；第二次连接自动放行
    const harness = installMcpHarness({
      beforeInitialize: (_name, attempt) => gates.waitIfClaimed(attempt),
    });
    harness.install();

    const client = new MCPClient();
    harness.beginAttempt(); // attempt 0
    const first = client.connect({ name: "dup", transport: "stdio", command: "npx" });
    await Promise.resolve(); // 第一次连接卡在它自己的闸门上

    await client.disconnect("dup");

    harness.beginAttempt(); // attempt 1 —— 它的 initialize 不等闸门，一路走完
    const second = await client.connect({ name: "dup", transport: "stdio", command: "npx" });
    expect(second.status, "第二次连接应当正常连上").toBe("connected");
    expect(second.tools.map((t) => t.name), "第二次连接应当拿到工具").toEqual(["t_search"]);

    // 现在才让**第一次**连接的握手返回 —— 它必须认得出自己已经过期
    gates.open(0);
    const firstConn = await first;

    expect(firstConn.status, "过期的连接必须按已取消结束").toBe("disconnected");
    const live = client.getStatus("dup");
    expect(live?.status, "新连接的状态不许被旧连接改写").toBe("connected");
    expect(live?.tools.map((t) => t.name), "新连接的工具清单不许被旧连接清掉").toEqual(["t_search"]);
    warn.mockRestore();
  });

  it("MCP-L4 反向对照：没被断开时正常连接，且 tools/list 成功之前不许报 connected", async () => {
    let sawConnectedBeforeTools = false;
    let probe!: MCPClient;
    const harness = installMcpHarness({
      toolsList: () => {
        sawConnectedBeforeTools = probe.getStatus("ok")?.status === "connected";
        return toolsOk(["a", "b"]);
      },
    });
    harness.install();

    probe = new MCPClient();
    harness.beginAttempt();
    const conn = await probe.connect({ name: "ok", transport: "stdio", command: "npx" });

    expect(conn.status).toBe("connected");
    expect(conn.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(
      sawConnectedBeforeTools,
      "tools/list 还没回来就报 connected 就是第 84 波那个「假连接」",
    ).toBe(false);
  });

  it("MCP-L5: 卡在 tools/list 时断开 → 同样收进程、同样不写回 connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gates = handshakeGates();
    gates.claim(0); // 这一次连接的 tools/list 会被堵住（initialize 不认领，直接放行）
    const harness = installMcpHarness({
      beforeToolsList: (_name, nth) => gates.waitIfClaimed(nth),
    });
    harness.install();

    const client = new MCPClient();
    harness.beginAttempt();
    const connecting = client.connect({ name: "half", transport: "stdio", command: "npx" });
    await new Promise((r) => setTimeout(r, 0)); // 走到 tools/list 那个 await

    await client.disconnect("half");
    expect(
      harness.countOf("mcp_stdio_disconnect"),
      "握手已过、工具清单没回来时断开，也必须收进程",
    ).toBe(1);

    gates.openAll();
    const conn = await connecting;
    expect(conn.status, "过期连接不许写回 connected").toBe("disconnected");
    expect(client.getAllTools()).toHaveLength(0);
    warn.mockRestore();
  });
});
