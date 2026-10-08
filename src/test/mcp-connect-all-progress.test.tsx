/**
 * MCP「全部连接」：**并发发起 + 逐条更新 + 进行中态**（第 184 波，G8 取证）。
 *
 * ## 缺陷形态（改前，已取证）
 *
 * | 位置 | 改前 |
 * | --- | --- |
 * | `mcp.ts` 的 `connectAll` | `for (const c of this.configs) await connect(c)` —— **串行** |
 * | `McpManager.handleConnectAll` | 结果**收齐**再一次性 `setStatuses`，期间不置「连接中…」 |
 * | 「全部连接」按钮 | 没有进行中态，可以连点 |
 *
 * 后果（单次 stdio 请求 30s 超时，一次连接要做 handshake + tools/list）：一台挂住的
 * 服务器会把它**后面所有**服务器一起拖住（累计可达 ~60s），用户全程看到「未连接」。
 * 对照：上游 Pi 在 v1.1.0 修了同一个问题（`/mcp` 不再等所有服务器连接完成、manager 实时更新）。
 *
 * ## 这些判据是怎么造的（为什么它断言的是产品行为）
 *
 * 跑的都是**真品**：真 `MCPRegistry` / `MCPClient`，真 `McpManager` 组件渲染 ——
 * 只有两处是测试双，且都是**边界**而不是被测逻辑：
 *
 * 1. `getMCPRegistry()` 换成「返回本用例新建的那个实例」（`vi.mock` + `importOriginal`
 *    透传其余导出）。必须换的理由：它是**模块级单例**（`mcp.ts` 末尾 `let instance`），
 *    一个文件里跑多个用例会互相串配置；换成每例新建就与真机同形。
 * 2. Rust 侧 IPC（`mcp_stdio_connect` / `mcp_stdio_request` / `mcp_stdio_disconnect`）
 *    换成可控桩 —— 真机上那是进程，测试里只能是桩。桩按 **JSON-RPC 方法名**分派，
 *    并且**能按服务器名精确卡住**某一台的 handshake（判据靠它造出「有的回来了、有的还在连」）。
 *
 * 所以「并发」「逐条回调」「错误隔离」断言的是 `mcp.ts` / `McpManager.tsx` 的真实行为，
 * 不是桩的自说自话。
 *
 * ## 用例地图
 *
 * | # | 层 | 判据 |
 * | --- | --- | --- |
 * | MCP-ALL-1 | 协议层 | 三台的 `initialize` **同时在途**（串行实现这里是 1） |
 * | MCP-ALL-2 | 协议层 | 每条**一有结果就回调那一条**，不等其余；整批不许提前结算 |
 * | MCP-ALL-3 | 协议层 | 一台失败只影响它自己（其余照常连上，整批不 reject） |
 * | MCP-ALL-4 | 协议层 | 回调自己抛错也不许掀翻整批 |
 * | MCP-ALL-5 | 组件层 | 连接期间该条显示「连接中…」；先回来的那条**立刻**变「已连接」 |
 * | MCP-ALL-6 | 组件层 | 按钮有进行中态（禁用 + 文案），重复点击不会再发一拨 |
 * | MCP-ALL-7 | 组件层 | 反向对照：单条「连接」的既有语义不变（只有被点的那条转圈） |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

/** `vi.mock` 会被提升到 import 之前 ⇒ 桩实例只能走 `vi.hoisted`（与 PluginManager 判据同一手法） */
const h = vi.hoisted(() => ({ registry: null as any }));

vi.mock("../core/mcp/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/mcp/mcp")>();
  // 只换单例取用口：MCPRegistry / MCPClient / 其余导出都是真品
  return { ...actual, getMCPRegistry: () => h.registry };
});

import { McpManager } from "../components/McpManager";
import { MCPRegistry, type MCPServerConfig, type MCPServerStatus } from "../core/mcp/mcp";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

// ========== 造法基座 ==========

const SERVERS: MCPServerConfig[] = [
  { name: "alpha", transport: "stdio", command: "npx" },
  { name: "beta", transport: "stdio", command: "npx" },
  { name: "gamma", transport: "stdio", command: "npx" },
];

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2024-11-05",
    serverInfo: { name: "demo", version: "1.0.0" },
    capabilities: {},
  },
});

function toolsOk(names: string[]): string {
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

/** 按**服务器名**精确卡住某一台的 handshake（`claim` 之后它就一直停在那里，直到 `open`） */
function nameGates() {
  const map = new Map<string, { promise: Promise<void>; open: () => void }>();
  const open = (name: string) => {
    map.get(name)?.open();
    map.delete(name);
  };
  return {
    /** 认领并堵住 `name` 这台（重复调用无副作用） */
    claim(name: string) {
      if (map.has(name)) return;
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      map.set(name, { promise, open: release });
    },
    waitIfClaimed: (name: string): Promise<void> | undefined => map.get(name)?.promise,
    open,
    openAll() {
      for (const n of [...map.keys()]) open(n);
    },
  };
}

interface StubHooks {
  /** `initialize` 进来时先等这个（用来造「还在连」的那一台） */
  beforeInitialize?: (name: string, nth: number) => Promise<void> | undefined;
  /** 返回 true ⇒ 这一台的 `initialize` **失败**（造错误隔离） */
  failInitialize?: (name: string) => boolean;
}

/**
 * Rust 侧 IPC 桩。
 *
 * `maxInFlight` 是 MCP-ALL-1 的核心读数：**同时在途的 `initialize` 条数**。
 * 串行实现下它必然恒为 1（前一条不回来，后一条根本发不出去）。
 */
function installTauriStub(hooks: StubHooks = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let initializeCount = 0;

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
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              await hooks.beforeInitialize?.(name, nth);
              if (hooks.failInitialize?.(name)) throw new Error(`initialize 被拒：${name}`);
              return INIT_OK;
            } finally {
              inFlight -= 1;
            }
          }
          if (method === "tools/list") return toolsOk([`${name}_tool`]);
          throw new Error(`test harness: unexpected method "${method}"`);
        }
        throw new Error(`test harness: unexpected command "${cmd}"`);
      },
    },
  };

  return {
    calls,
    maxInFlight: () => maxInFlight,
    countOf: (cmd: string) => calls.filter((c) => c === cmd).length,
  };
}

// ========== 组件层取用口 ==========

function rowOf(name: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".mcp-server-item"));
  const hit = rows.find((r) => r.querySelector(".mcp-server-name")?.textContent === name);
  if (!hit) throw new Error(`界面上找不到服务器「${name}」那一行（现有行：${rows.length}）`);
  return hit;
}

function statusTextOf(name: string): string {
  return rowOf(name).querySelector(".mcp-status-dot")?.textContent ?? "";
}

function connectBtnOf(name: string): HTMLButtonElement | null {
  return rowOf(name).querySelector<HTMLButtonElement>("button.mcp-server-btn.connect");
}

function disconnectBtnOf(name: string): HTMLButtonElement | null {
  return rowOf(name).querySelector<HTMLButtonElement>("button.mcp-server-btn.disconnect");
}

function connectAllBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>("button.connect-all-btn");
  if (!btn) throw new Error("找不到「全部连接」按钮（.connect-all-btn）");
  return btn;
}

beforeEach(() => {
  // 「磁盘上」就配了这三台；端口已预热 ⇒ 与真机「注册那一刻设置面已就绪」同形
  setStoragePort(
    createFakeStoragePort({
      seed: { settings: [{ key: "codem-mcp-servers", value: JSON.stringify(SERVERS) }] },
    }),
  );
  // 每例一个新实例：真机上是单例，测试里换掉取用口即可（见文件头）
  h.registry = new MCPRegistry();
});

afterEach(() => {
  cleanup();
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

// ========== 协议层：connectAll 本身 ==========

describe("MCP 全部连接：并发 + 逐条（协议层，真 MCPRegistry/MCPClient）", () => {
  it("MCP-ALL-1: 三台的 handshake 必须同时在途（串行实现这里只能是 1）", async () => {
    // 每台都在 initialize 上停 30ms：并发的三台必然重叠，串行的永远重叠不了
    const stub = installTauriStub({
      beforeInitialize: async () => {
        await new Promise((r) => setTimeout(r, 30));
      },
    });

    const statuses = await h.registry.connectAll();

    expect(
      stub.maxInFlight(),
      "同时在途的 initialize 条数 —— 串行的 for…await 会让它恒为 1，一台卡住就把它后面全部拖住",
    ).toBe(3);
    expect(statuses.map((s: MCPServerStatus) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(statuses.every((s: MCPServerStatus) => s.connected)).toBe(true);
  });

  it("MCP-ALL-2: 每条一有结果就回调那一条，不等其余（整批也不许提前结算）", async () => {
    const gates = nameGates();
    gates.claim("gamma"); // gamma 卡在握手上，一直不回来
    installTauriStub({ beforeInitialize: (name) => gates.waitIfClaimed(name) });

    const got: string[] = [];
    let settled = false;
    const all = h.registry
      .connectAll((s: MCPServerStatus) => got.push(s.name))
      .then((r: MCPServerStatus[]) => {
        settled = true;
        return r;
      });

    await waitFor(() => expect([...got].sort()).toEqual(["alpha", "beta"]));
    expect(got, "gamma 还没结果，它就不该出现在回调里").not.toContain("gamma");
    expect(
      settled,
      "还有服务器在连的时候整批不许结算 —— 改前正是「等齐了才一次性更新」，用户全程看不到进展",
    ).toBe(false);

    gates.open("gamma");
    const results = await all;
    expect(results.map((r: MCPServerStatus) => r.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect([...got].sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("MCP-ALL-3: 一台失败只影响它自己 —— 其余照常连上，整批不 reject", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installTauriStub({ failInitialize: (name) => name === "beta" });

    const results = await h.registry.connectAll();
    const byName = new Map(results.map((r: MCPServerStatus) => [r.name, r]));

    expect(byName.get("beta")!.connected, "失败的那台如实报失败").toBe(false);
    expect(byName.get("beta")!.error, "失败必须带原因（第 84 波：不许静默假成功）").toContain("beta");
    expect(byName.get("alpha")!.connected, "一台失败不许影响其他台").toBe(true);
    expect(byName.get("gamma")!.connected, "一台失败不许影响其他台").toBe(true);
    expect(byName.get("alpha")!.tools.map((t) => t.name)).toEqual(["alpha_tool"]);
    warn.mockRestore();
  });

  it("MCP-ALL-4: 回调自己抛错也不许掀翻整批（界面回调无权杀死其他服务器的连接结果）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installTauriStub();

    const results = await h.registry.connectAll(() => {
      throw new Error("界面回调炸了");
    });

    expect(results.map((r: MCPServerStatus) => r.connected)).toEqual([true, true, true]);
    warn.mockRestore();
  });
});

// ========== 组件层：McpManager 的「全部连接」 ==========

describe("MCP 全部连接：界面逐条进度（真组件渲染）", () => {
  it("MCP-ALL-5: 连上的那条立刻变「已连接」，还在连的那条显示「连接中…」", async () => {
    const gates = nameGates();
    gates.claim("gamma"); // 只卡 gamma ⇒ alpha/beta 会先回来
    installTauriStub({ beforeInitialize: (name) => gates.waitIfClaimed(name) });

    render(<McpManager onClose={() => {}} />);
    fireEvent.click(connectAllBtn());

    // ① 还没回来的那条：复用单条连接那条路径的文案与禁用语义
    await waitFor(() => expect(connectBtnOf("gamma")).not.toBeNull());
    expect(
      connectBtnOf("gamma")!.textContent,
      "连接期间该条必须显示「连接中…」（改前它一直显示「连接」，状态也停在「未连接」）",
    ).toContain("连接中");
    expect(connectBtnOf("gamma")!.disabled, "连接中的那条按钮点不动").toBe(true);
    expect(statusTextOf("gamma"), "还没结果 ⇒ 状态仍是未连接（不许谎报）").toBe("未连接");

    // ② 先回来的那两条：**一有结果就更新它自己**，不等 gamma
    await waitFor(() => expect(statusTextOf("alpha")).toBe("已连接"));
    expect(statusTextOf("beta"), "同一批里先回来的那条也要立刻更新").toBe("已连接");
    expect(disconnectBtnOf("alpha"), "已连上 ⇒ 该行是「断开」按钮").not.toBeNull();
    expect(statusTextOf("gamma"), "gamma 还没回来，不许被提前写成结果").toBe("未连接");

    // ③ 放开 gamma：它也接上，界面上不留任何「连接中」
    gates.open("gamma");
    await waitFor(() => expect(statusTextOf("gamma")).toBe("已连接"));
    expect(
      document.body.textContent,
      "全部完成后不许残留「连接中」（按钮的进行中态也必须退掉）",
    ).not.toContain("连接中");
  });

  it("MCP-ALL-6: 进行中按钮点不动（禁用 + 进行中文案），重复点击不会再发一拨", async () => {
    const gates = nameGates();
    for (const s of SERVERS) gates.claim(s.name);
    const stub = installTauriStub({ beforeInitialize: (name) => gates.waitIfClaimed(name) });

    render(<McpManager onClose={() => {}} />);
    const btn = connectAllBtn();
    fireEvent.click(btn);

    await waitFor(() => expect(stub.countOf("mcp_stdio_connect")).toBe(3));
    expect(btn.disabled, "进行中必须点不动（改前完全没有进行中态）").toBe(true);
    expect(btn.textContent, "按钮要有进行中态").toContain("全部连接中");

    /*
     * 再点一次。真机上 DOM 会把 disabled 按钮的 click 吞掉，所以这里能派发出去是**更严**的造法：
     * 处理器自己那道「进行中直接忽略」的闸门必须挡住它（否则会并发发起第二拨）。
     */
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.countOf("mcp_stdio_connect"), "重复点击不许再发一拨连接").toBe(3);

    gates.openAll();
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.textContent, "结束后要退回原文案").toContain("全部连接");
    expect(btn.textContent).not.toContain("全部连接中");
  });

  it("MCP-ALL-7: 反向对照 —— 单条「连接」的既有语义不变（只有被点的那一条转圈）", async () => {
    const gates = nameGates();
    gates.claim("beta");
    installTauriStub({ beforeInitialize: (name) => gates.waitIfClaimed(name) });

    render(<McpManager onClose={() => {}} />);
    fireEvent.click(connectBtnOf("beta")!);

    await waitFor(() => expect(connectBtnOf("beta")!.textContent).toContain("连接中"));
    expect(connectBtnOf("beta")!.disabled).toBe(true);
    expect(
      connectBtnOf("alpha")!.textContent,
      "只点了一条 ⇒ 别的服务器不许被卷进「连接中」",
    ).not.toContain("连接中");
    expect(connectBtnOf("alpha")!.disabled, "别的服务器的连接按钮不许被锁").toBe(false);
    expect(statusTextOf("alpha")).toBe("未连接");
    expect(connectAllBtn().disabled, "单条连接不许把「全部连接」也锁上").toBe(false);

    gates.open("beta");
    await waitFor(() => expect(statusTextOf("beta")).toBe("已连接"));
    expect(statusTextOf("alpha"), "单条连接仍不碰其他条目").toBe("未连接");
  });
});
