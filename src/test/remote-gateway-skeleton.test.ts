/**
 * PC 桌面远程网关判据（GW-1..GW-8，ADR-0005 M2）。
 *
 * 这组判据守的是“网关真的通电了，而且只有一套”：
 * 1. TS 侧只认 `/health` 与 `/rpc` —— `/events` 是 Rust 的 SSE 长连接，不经过渲染层；
 * 2. `/health` 由渲染层回答（不是 Rust 侧编一个常量），其它路径/方法如实拒绝；
 * 3. 非网关路径**不应答**，否则会抢走 AA 的 `/api/*`；
 * 4. Rust 只绑回环、只有一处事件桥；静态 UI 来自 `packages/host/web`；
 *    M2 的 SSE 事件枢纽在 `gateway/events.rs`，`gateway_publish_event` 是唯一发布入口；
 * 5. 配对是 6 位一次性码 + HttpOnly cookie（Rust 单测钉真实 TCP）；
 * 6. `/rpc` 的白名单 = 4 个只读 + 写 2 条 + 审批 2 条（其余写方法仍被拒绝）；
 * 7. 共享 UI 的写模式由 `host.hello.capabilities` 决定（M1 的注入标记已删除）；
 * 8. 静态 UI 随 stage 进安装包。
 *
 * 真实 HTTP/TCP（配对、cookie、静态资源、白名单转发、SSE 续传）由 Rust 单测
 * `cargo test --lib phone::gateway` 钉住，这里不重复起监听器。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  GATEWAY_HEALTH_PATH,
  GATEWAY_HOST_ID,
  GATEWAY_RPC_METHODS,
  GATEWAY_RPC_PATH,
  GATEWAY_SERVICE_NAME,
  gatewayReply,
  gatewayRpcReply,
  handleGatewayRequest,
  parseGatewayPath,
  type GatewayDataDeps,
} from "../core/remote/gateway-engine";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const GATEWAY_DIR = "src-tauri/src/phone/gateway";

/** 去掉注释：注释里解释“旧实现已删除”不该把自己判红。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const gatewayRust = () =>
  readdirSync(join(ROOT, GATEWAY_DIR))
    .filter((f) => f.endsWith(".rs"))
    .map((f) => ({ file: `${GATEWAY_DIR}/${f}`, code: stripComments(read(`${GATEWAY_DIR}/${f}`)) }));

const SESSION = {
  id: "sess-desktop-1",
  title: "桌面会话",
  projectId: "proj-1",
  projectName: "demo",
  updatedAt: 1_700_000_000_000,
  createdAt: 1_699_000_000_000,
  messageCount: 2,
};

function deps(overrides: Partial<GatewayDataDeps> = {}): GatewayDataDeps {
  return {
    listSessions: () => [SESSION],
    sync: {
      pull: async () => ({
        events: [],
        nextSeq: 0,
        hasMore: false,
        devices: 0,
        scannedSessions: 0,
        missingBodies: 0,
        droppedEntries: 0,
        droppedUnpulled: 0,
        resetRequired: false,
        oldestSeq: 0,
        filteredSessions: 0,
        overCapacity: false,
        serverTime: 0,
      }),
      push: async () => ({
        accepted: 0,
        duplicates: 0,
        rejected: [],
        hostSeqMax: 0,
        devices: 0,
        storageFailed: 0,
        filteredSessions: 0,
      }),
      snapshot: async () => ({
        sessionId: "",
        messages: [],
        nextBefore: null,
        hasMore: false,
        total: 0,
        hostSeq: 0,
        filteredSessions: 0,
        serverTime: 0,
      }),
      mergeMemory: async () => ({ ok: true, payload: "", entries: 0, conflicts: [], changed: false }),
    },
    getSession: (id, limit) => {
      if (id !== SESSION.id) return null;
      return {
        session: SESSION,
        messages: [
          { id: "m1", role: "user", content: "你好", timestamp: 1_700_000_000_001 },
          { id: "m2", role: "assistant", content: "你好，这里是桌面", timestamp: 1_700_000_000_002 },
        ].slice(0, limit),
        hasMore: false,
        // 手机刷新后恢复"停止"按钮所需的实时运行态
        run: { runId: "run-live", state: "running" },
      };
    },
    // 写路径的实现在 `desktop-engine`；这里只需要能记录"被调到了没有"。
    sendPrompt: async () => ({ ok: true, runId: "run-test", sessionId: SESSION.id }),
    cancelRun: () => ({
      ok: true,
      runId: "run-test",
      sessionId: SESSION.id,
      cancelled: true,
      state: "running",
    }),
    listApprovals: () => [],
    respondApproval: (input) => ({
      ok: true,
      approvalId: input.approvalId,
      decision: input.decision,
      decidedBy: "phone",
    }),
    // M3 文件面：判据只需要能看到"数据层被调到了没有"，真实边界/审批在
    // `gateway-workspace.test.ts` 里用临时目录与假 invoke 验证。
    workspace: {
      list: async (path: string) => ({ path, entries: [] }),
      read: async (path: string) => ({ path, size: 0, truncated: false, text: "", encoding: "utf8" }),
      diff: async (path: string) => ({ path, diff: "", supported: true }),
      root: async () => "C:\\desktop-project",
    },
    changes: {
      list: async () => ({ items: [], hasMore: false, supported: true }),
      diff: async (sessionId: string, changeId: string, path: string) => ({
        path,
        status: "M",
        patch: "",
        truncated: false,
        supported: true,
      }),
    },
    // B1：项目/会话创建（能力表完整所需；创建行为在 gateway-create.test.ts）
    listProjects: () => [],
    createProject: async () => ({
      ok: true,
      value: { id: "proj-test", name: "p", path: "C:\\p", pinned: false, lastAccessedAt: 1 },
    }),
    createSession: async () => ({ ok: true, value: { id: "sess-test", title: "t" } }),
    ...overrides,
  };
}

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

describe("PC 桌面远程网关 M1（ADR-0005）", () => {
  it("GW-1: TS 只认 /health 与 /rpc；/events 是 Rust 侧 SSE，旧 LAN 路由不得回来", () => {
    expect(parseGatewayPath(GATEWAY_HEALTH_PATH)).toEqual({ type: "health" });
    expect(parseGatewayPath(GATEWAY_RPC_PATH)).toEqual({ type: "rpc" });
    for (const path of ["/", "/healthz", "/api/sessions", "/pair", "/ca.crt", "/local-auth"]) {
      expect(parseGatewayPath(path), `${path} 不该是网关路由`).toBeNull();
    }
    // `/events` 由 Rust 直接流式发送（见 `gateway/events.rs`）；渲染层如果也认领它，
    // 就会变成"一条请求两个处理方"。这里钉住：TS 侧**不认领**。
    expect(parseGatewayPath("/events"), "/events 不经过渲染层").toBeNull();
  });

  it("GW-2: /health 的应答形状固定；/rpc 不属于 health 纯函数", () => {
    expect(gatewayReply("GET", "/health")).toEqual({
      status: 200,
      body: { ok: true, service: GATEWAY_SERVICE_NAME },
    });
    const post = gatewayReply("POST", "/health");
    expect(post?.status).toBe(405);
    expect(JSON.stringify(post?.body)).toContain("method_not_allowed");
    expect(gatewayReply("POST", "/rpc")).toBeNull();
  });

  it("GW-3: health 与 rpc 才应答，非网关路径不抢 AA 的 /api/*", async () => {
    const seen: Array<[number, unknown]> = [];
    const respond = async (status: number, body: unknown) => {
      seen.push([status, body]);
    };

    await expect(
      handleGatewayRequest({ method: "GET", path: "/health" }, respond, deps()),
    ).resolves.toBe(true);
    expect(seen).toEqual([[200, { ok: true, service: GATEWAY_SERVICE_NAME }]]);

    seen.length = 0;
    await expect(
      handleGatewayRequest(
        { method: "POST", path: "/rpc", body: rpc("session.list") },
        respond,
        deps(),
      ),
    ).resolves.toBe(true);
    expect(seen[0][0]).toBe(200);
    expect((seen[0][1] as any).result.items).toHaveLength(1);

    seen.length = 0;
    await expect(
      handleGatewayRequest({ method: "GET", path: "/api/sessions" }, respond, deps()),
    ).resolves.toBe(false);
    expect(seen, "非网关路径被应答 = AA 的 /api/* 会被网关抢答").toEqual([]);
  });

  it("GW-4: 只绑回环、只有一处发事件，配对/UI 走网关自己而不是旧 LAN", () => {
    const mod = gatewayRust().find((f) => f.file.endsWith("/mod.rs"));
    expect(mod, "网关 mod.rs 必须存在").toBeTruthy();
    const code = mod!.code;

    expect(code).toContain('const BIND_ADDR: &str = "127.0.0.1:0";');
    expect(code).toContain("TcpListener::bind(BIND_ADDR)");
    expect(code).toContain("pub async fn start(");
    expect(code).toContain("pub async fn stop(");
    expect(code).toContain("pair.claim");
    expect(code).toContain("RPC_ALLOWED_METHODS");
    /**
     * 必须读**白名单常量本身**，而不是整个文件里出现过这个字符串。
     *
     * 为什么：`#[cfg(test)] mod tests` 里的 `rpc_body("prompt.send", …)` 也含
     * `"prompt.send"` —— 按整文件搜字符串的话，把生产白名单删掉这条判据照样绿
     * （变异自证时真的发生了）。这里只取 `RPC_ALLOWED_METHODS` 的数组字面量。
     */
    const whitelist =
      /const RPC_ALLOWED_METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(code)?.[1] ?? "";
    expect(whitelist, "找不到 Rust 的 RPC_ALLOWED_METHODS 数组").not.toBe("");
    for (const method of GATEWAY_RPC_METHODS) {
      expect(whitelist, `Rust 白名单必须包含 ${method}`).toContain(`"${method}"`);
    }
    // 仍未实现的方法不得混进白名单（与 TS 侧 GATEWAY_UNSUPPORTED_METHODS 互为镜像）
    for (const banned of ["run.guidance", "attachment.put", "events"]) {
      expect(whitelist, `未实现的方法不得进 Rust 白名单：${banned}`).not.toContain(`"${banned}"`);
    }
    // B1：项目面三条已实现 ⇒ 必须同时在 Rust 白名单里（两侧允许集合一致）
    for (const implemented of ["session.create", "project.list", "project.create"]) {
      expect(whitelist, `已实现的方法必须进 Rust 白名单：${implemented}`).toContain(`"${implemented}"`);
    }

    const files = gatewayRust();
    const all = files.map((f) => f.code).join("\n");
    const pairing = files.find((f) => f.file.endsWith("/pairing.rs"));
    expect(pairing, "配对模块必须存在").toBeTruthy();
    expect(pairing!.code).toContain("codem_gateway_device");
    expect(pairing!.code).toContain("PAIR_CODE_TTL_MS");
    expect(pairing!.code).toContain("MAX_FAILURES_PER_WINDOW");

    // 事件桥只有一处：网关必须走 phone::forward_to_renderer，不许自己 emit
    expect(all).not.toMatch(/\.emit\s*\(/);
    expect(all).not.toContain('"remote-request"');
    expect(all).not.toContain('"remote_respond"');
    expect(all).toContain("forward_to_renderer");

    // M2：SSE 事件枢纽必须在网关模块里（不是渲染层伪造的轮询）
    expect(all).toContain("pub mod events;");
    const events = files.find((f) => f.file.endsWith("/events.rs"));
    expect(events, "事件枢纽 events.rs 必须存在").toBeTruthy();
    // 续传头在 `handle_events` 里读（mod.rs），事件枢纽负责按水位补发。
    expect(all).toContain("last-event-id");
    expect(events!.code).toContain("pub const RESET_EVENT");
    expect(events!.code).toContain("PUBLISHABLE_EVENT_TYPES");

    // 旧 phone-link 的那些东西一个都不许回来
    for (const banned of [
      "0.0.0.0",
      "include_str!",
      "rcgen",
      "rustls",
      "qrcode",
      "pair_url",
      "codem_phone",
      "devices.json",
      "x-codem-edge",
    ]) {
      for (const f of files) {
        expect(f.code, `${f.file} 不得出现旧标识 ${banned}`).not.toContain(banned);
      }
    }

    // 共享 UI 从 packages/host/web 的构建物来（或 stage 后的 resources/host/web）
    const assets = files.find((f) => f.file.endsWith("/assets.rs"));
    expect(assets, "静态资源模块必须存在").toBeTruthy();
    expect(assets!.code).toContain("host");
    expect(assets!.code).toContain("web");
    expect(assets!.code).toContain("index.html");
    expect(assets!.code).toContain("ui.js");
    expect(assets!.code).toContain("ui.css");
    /**
     * M2：只读标记**已删除**。写模式由 `host.hello.capabilities` 决定，
     * 网关再往 index.html 注入开关就会变成第二个真相（且会与白名单漂移）。
     *
     * 只看生产代码（`#[cfg(test)]` 之后是判据自己的断言字符串）。
     */
    const assetsProd = assets!.code.split("#[cfg(test)]")[0];
    expect(assetsProd, "M2 不得再注入只读标记").not.toContain("__CODEM_GATEWAY_READ_ONLY__");
    expect(assetsProd, "M2 不得再改写 index.html").not.toContain("READ_ONLY_SNIPPET");

    // 命令在 lib.rs 注册（没有注册 = 写了但接不上）
    const lib = read("src-tauri/src/lib.rs");
    for (const cmd of [
      "phone::gateway::gateway_start",
      "phone::gateway::gateway_stop",
      "phone::gateway::gateway_status",
      "phone::gateway::gateway_pair_start",
      "phone::gateway::gateway_publish_event",
    ]) {
      expect(lib, `lib.rs 必须注册 ${cmd}`).toContain(cmd);
    }
    expect(lib).toContain("phone::gateway::GatewayState::new()");
    expect(lib).toContain(".manage(gateway_state.clone())");

    // 设置页必须真的渲染这张卡（写了组件但没挂上 = 没有入口），
    // 而且 M4 之后不得再出现第二个“连电脑”入口（桌面 Host sidecar）。
    const access = read("src/components/RemoteAccessSettings.tsx");
    expect(access).toContain("<RemoteGatewaySection");
    expect(access).toContain("桌面远程网关");
    expect(access).not.toContain("<RemoteHostSection");
    expect(existsSync(join(ROOT, "src/components/RemoteHostSection.tsx"))).toBe(false);

    // 桌面不再自启/同步 Host；Rust 也不再注册 host_cmd 命令。
    expect(read("src/main.tsx")).not.toContain("bootstrapRemoteHost");
    expect(read("src/App.tsx")).not.toContain("syncRemoteHostWorkspace");
    expect(lib).not.toContain("host_cmd");
  });

  it("GW-5: 渲染层网关不碰 LLM/会话/存储；只通过桌面注入读数据", () => {
    const engine = stripComments(read("src/core/remote/gateway-engine.ts"));
    for (const banned of ['from "../llm', 'from "../session', 'from "../storage', "MessageStorage", "executeSessionTurn"]) {
      expect(engine, `网关渲染层不得 import/调用 ${banned}`).not.toContain(banned);
    }
    expect(engine).toContain("listSessions");
    expect(engine).toContain("getSession");

    // 必须挂在**同一条** remote-request 桥上（唯一监听器），不是另起一个监听
    const desktop = read("src/core/remote/desktop-engine.ts");
    expect(desktop, "desktop-engine 必须把网关路径转给 gateway-engine").toContain("handleGatewayRequest");
    expect(desktop).toContain("flattenSessions");
    expect(desktop).toContain("gatewaySessionDetail");
    /**
     * P0-0（D1/E5/D11）：这个唯一同步读点仍然是**一处**，入口从 `listMessages`
     * 换成 `listDisplayMessages`（换过段的会话必须读完整时间线）。
     * 断言仍然钉「读点必须在这一层、且只有一个函数名」，不许退回投影视图。
     */
    expect(desktop).toContain("MessageStorage.listDisplayMessages");
    expect(desktop, "不许退回投影视图（换段后手机会少一段）").not.toContain("MessageStorage.listMessages");
    expect(desktop).toContain('listen("remote-request"');
    expect(desktop).not.toContain('listen("gateway-request"');
  });

  it("GW-6: /rpc 白名单 = 只读 4 条 + 写 2 条 + 审批 2 条 + 文件面 3 条 + 变更面 2 条 + 项目面 3 条 + 多设备同步 4 条；其余方法被拒绝", async () => {
    expect([...GATEWAY_RPC_METHODS]).toEqual([
      "host.hello",
      "host.diagnostics",
      "session.list",
      "session.get",
      "session.create",
      "project.list",
      "project.create",
      "prompt.send",
      "run.cancel",
      "approval.list",
      "approval.respond",
      "workspace.list",
      "workspace.read",
      "workspace.diff",
      "session.changes",
      "session.change.diff",
      "sync.pull",
      "sync.push",
      "sync.memory",
      "sync.snapshot",
    ]);

    const hello = await gatewayRpcReply(rpc("host.hello", { protocolVersion: 1 }), deps());
    expect((hello.result as any).hostId).toBe(GATEWAY_HOST_ID);
    expect((hello.result as any).capabilities.supported).toContain("session.list");
    // M2：能力表必须**如实**包含写与审批，且不再把它们列进 unsupported。
    expect((hello.result as any).capabilities.supported).toEqual([...GATEWAY_RPC_METHODS]);
    for (const method of ["prompt.send", "run.cancel", "approval.list", "approval.respond"]) {
      expect((hello.result as any).capabilities.unsupported).not.toContain(method);
    }

    const list = await gatewayRpcReply(rpc("session.list", { limit: 20 }), deps());
    expect((list.result as any).items[0]).toMatchObject({ id: SESSION.id, title: SESSION.title });

    const got = await gatewayRpcReply(rpc("session.get", { sessionId: SESSION.id }), deps());
    expect((got.result as any).session.id).toBe(SESSION.id);
    expect((got.result as any).messages).toHaveLength(2);
    // 网关 run 的实时状态随 session.get 回来（手机刷新后仍能拿到"停止"所需的 runId）。
    expect((got.result as any).run).toEqual({ runId: "run-live", state: "running" });

    const missing = await gatewayRpcReply(rpc("session.get", { sessionId: "nope" }), deps());
    expect((missing.error as any).data.kind).toBe("NOT_FOUND");

    // 还没实现的写方法：即使数据层意外可达，也不能被网关调用。
    let depsTouched = 0;
    const guarded = deps({
      listSessions: () => {
        depsTouched += 1;
        return [SESSION];
      },
      listApprovals: () => {
        depsTouched += 1;
        return [];
      },
    });
    for (const method of ["run.guidance", "attachment.put"]) {
      const reply = await gatewayRpcReply(rpc(method), guarded);
      expect((reply.error as any).data.kind, method).toBe("UNSUPPORTED");
    }
    expect(depsTouched).toBe(0);
    // B1：session.create 现在**已实现**，不再走 UNSUPPORTED 分支（它必须落到注入的数据层）
    expect((hello.result as any).capabilities.supported).toContain("session.create");

    // 审批两条**必须**落在注入的数据层上（不是网关自己编一个空列表）。
    const approvalList = await gatewayRpcReply(rpc("approval.list", {}), guarded);
    expect((approvalList.result as any).approvals).toEqual([]);
    expect(depsTouched).toBe(1);

    const bad = await gatewayRpcReply("{not json", deps());
    expect((bad.error as any).data.kind).toBe("PARSE_ERROR");
  });

  it("GW-7: 共享 UI 的写模式由 capabilities 决定（只读标记已删除）", () => {
    const browser = stripComments(read("packages/ui/src/browser.tsx"));
    expect(browser, "M2 不得再读宿主注入的只读标记").not.toContain("__CODEM_GATEWAY_READ_ONLY__");
    expect(browser, "browser 不再给 MobileApp 传 readOnly").not.toContain("readOnly={readOnly}");
    expect(browser).toContain("<MobileApp");

    const app = stripComments(read("packages/ui/src/mobile-app.tsx"));
    // **唯一**判据：服务器能力表（旧 Host 没有能力表时按远程第一版兼容）
    expect(app).toContain("capabilitiesFromMethods(supported)");
    expect(app).toContain("canWriteSessions(supported)");
    expect(app).not.toContain("__CODEM_GATEWAY_READ_ONLY__");
    // 能力不足时仍有明确的只读提示（不是静默少一块 UI）
    expect(app).toContain('data-testid="gateway-read-only"');
    // 入口按能力位消失：新建会话 / 文件 / 第三列
    expect(app).toContain("caps.createSession && transport?.createSession");
    expect(app).toContain("onOpenFiles={caps.workspaceWrite ?");
    expect(app).toContain("caps.workspaceWrite && transport ? (");
    // M3：变更页签必须按能力位（两条方法都开）决定，不许按"transport 有没有方法"猜。
    expect(app).toContain("sessionId && caps.changes ? (");

    // 构建物存在时，也必须真的包含能力判据（防止"改了源码但用了旧 ui.js"）
    const built = join(ROOT, "packages", "host", "web", "ui.js");
    if (existsSync(built)) {
      const bundle = read("packages/host/web/ui.js");
      expect(bundle, "旧构建物仍带只读标记 —— 先跑 npm run host:build:ui").not.toContain(
        "__CODEM_GATEWAY_READ_ONLY__",
      );
      expect(bundle).toContain("gateway-read-only");
    }
  });

  it("GW-8: 静态 UI 三件套随 stage 进入安装包，且不再带旧 Host sidecar 产物", () => {
    const stage = read("tools/build/stage-host-sidecar.mjs");
    expect(stage).toContain('index: join(repoRoot, "packages", "host", "web", "index.html")');
    expect(stage).toContain('ui: join(repoRoot, "packages", "host", "web", "ui.js")');
    expect(stage).toContain('css: join(repoRoot, "packages", "host", "web", "ui.css")');
    expect(stage).toContain('copyFileSync(sources.index, join(webOut, "index.html"))');
    expect(stage).toContain('copyFileSync(sources.ui, join(webOut, "ui.js"))');
    expect(stage).toContain('copyFileSync(sources.css, join(webOut, "ui.css"))');
    expect(stage).toContain('"ui.css": join(webOut, "ui.css")');

    // M4：桌面 Host sidecar 退役，stage 脚本不得再复制 host.mjs / codem-db-cli.exe；
    // 旧文件要被主动清掉，避免覆盖安装时又被带进安装包。
    expect(stage).not.toContain("sources.host");
    expect(stage).not.toContain("sources.db");
    expect(stage).toContain('const staleFiles = ["host.mjs", "codem-db-cli.exe"]');
    expect(stage).toContain('rmSync(join(outDir, name), { force: true })');

    // bundle 白名单也必须收窄到共享 UI，防止旧产物被 `resources/host/**/*` 带走。
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.bundle.resources).toContain("resources/host/web/**/*");
    expect(conf.bundle.resources).not.toContain("resources/host/**/*");
    // 构建链必须自己产出并 stage 共享 UI（不能再依赖安装目录里恰好存在的旧 ui.css）。
    expect(conf.build.beforeBuildCommand).toContain("host:build:ui");
    expect(conf.build.beforeBuildCommand).toContain("stage:host");

    // 构建脚本本身要同时产出 ui.js 与 ui.css。
    const buildUi = read("packages/host/scripts/build-ui.mjs");
    expect(buildUi).toContain('const cssOutfile = join(repoRoot, "packages", "host", "web", "ui.css")');
    expect(buildUi).toContain('entryPoints: [join(repoRoot, "packages", "ui", "src", "ui.css")]');
  });
});
