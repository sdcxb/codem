/**
 * 传输抽象的判据（TR-*）。
 *
 * 这一层决定"手机与桌面能不能共用一套组件"。必须证明：
 * 1. 远程传输把方法名/参数翻译对（不多调、不丢参）；
 * 2. 订阅按会话过滤、返回的取消函数真的取消；
 * 3. 本地传输**不依赖**渲染侧代码（用假实现即可构造）；
 * 4. 能力位是数据：remote 关掉终端/附件、打开多设备提示；local 全开。
 */
import { describe, expect, it, vi } from "vitest";

import {
  canWriteSessions,
  capabilitiesFor,
  capabilitiesFromMethods,
  can,
  localTransport,
  remoteTransport,
  type SessionTransport,
} from "../../packages/ui/src/transport";
import { createHostClient } from "../../packages/ui/src/host-client";

function fakeHostClient() {
  const calls: Array<[string, unknown]> = [];
  let listener: ((e: { seq: number; sessionId: string; type: string; payload: unknown }) => void) | null = null;
  const client = {
    rpc: async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "host.hello") return { hostId: "h1" };
      if (method === "session.list") return { items: [{ id: "s1", title: "t" }] };
      if (method === "session.get") return { session: { title: "t" }, messages: [] };
      if (method === "prompt.send") return { runId: "r1" };
      return { ok: true };
    },
    connect: vi.fn(),
    close: vi.fn(),
    onEvent: (cb: typeof listener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return {
    calls,
    client,
    emit: (e: { seq: number; sessionId: string; type: string; payload: unknown }) => listener?.(e),
  };
}

describe("TR-1 remoteTransport 翻译", () => {
  it("hello/list/get/send/cancel 的参数与返回值", async () => {
    const { calls, client } = fakeHostClient();
    const t = remoteTransport(client as never);
    expect(await t.hello()).toEqual({ hostId: "h1" });
    expect(await t.listSessions()).toEqual([{ id: "s1", title: "t" }]);
    expect(await t.getSession("s1")).toEqual({ title: "t", messages: [] });
    expect(await t.send("s1", "hi", "req-1")).toEqual({ runId: "r1" });
    await t.cancel("r1", "req-2");
    expect(calls.map((c) => c[0])).toEqual([
      "host.hello",
      "session.list",
      "session.get",
      "prompt.send",
      "run.cancel",
    ]);
    expect(calls[3][1]).toMatchObject({ sessionId: "s1", text: "hi", requestId: "req-1" });
    // cancel 必须带上与 send 同一个 clientId：网关靠它判断"是不是发起者在停自己的 run"。
    expect(calls[4][1]).toMatchObject({ runId: "r1", requestId: "req-2" });
    expect((calls[4][1] as { clientId?: string }).clientId).toBeTruthy();
    expect((calls[4][1] as { clientId?: string }).clientId).toBe(
      (calls[3][1] as { clientId?: string }).clientId,
    );
  });

  it("TR-1b: session.changes / session.change.diff 的方法名与参数", async () => {
    const { calls, client } = fakeHostClient();
    const t = remoteTransport(client as never);
    await t.sessionChanges!("s1", 20, 10);
    await t.sessionChangeDiff!("s1", "tfc-1", "src/a.ts");
    expect(calls.map((c) => c[0])).toEqual(["session.changes", "session.change.diff"]);
    expect(calls[0][1]).toEqual({ sessionId: "s1", offset: 20, limit: 10 });
    expect(calls[1][1]).toEqual({ sessionId: "s1", changeId: "tfc-1", path: "src/a.ts" });
  });

  it("订阅按会话过滤，取消后不再触发", () => {
    const { client, emit } = fakeHostClient();
    const t = remoteTransport(client as never);
    const got: string[] = [];
    const off = t.subscribe("s1", (e) => got.push(e.type));
    emit({ seq: 1, sessionId: "s2", type: "other", payload: {} });
    emit({ seq: 2, sessionId: "s1", type: "assistant.text", payload: {} });
    expect(got).toEqual(["assistant.text"]);
    off();
    emit({ seq: 3, sessionId: "s1", type: "run.finished", payload: {} });
    expect(got).toEqual(["assistant.text"]);
    expect((client as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledWith("s1");
  });
});

describe("TR-1c hostInfo 是只读观察者", () => {
  it("host.hello 不认领租约（claim:false），并透传 auth（不含 token）", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      rpc: async (method: string, params?: unknown) => {
        calls.push([method, params]);
        if (method === "host.hello") {
          return {
            hostId: "h1",
            capabilities: { supported: ["session.list"], unsupported: [] },
            auth: { kind: "device", deviceId: "dev-12345678", deviceName: "Pixel" },
          };
        }
        return { seq: 7, runs: [], workspaceRoot: "/w", workspaceSharedWithDesktop: true };
      },
    };
    const t = remoteTransport(client as never);
    const info = await t.hostInfo!();
    expect(calls[0][0]).toBe("host.hello");
    expect(calls[0][1]).toMatchObject({ claim: false });
    expect(info.auth).toEqual({ kind: "device", deviceId: "dev-12345678", deviceName: "Pixel" });
    // Phase 1 C：来源位透传（缺省不写 true，避免 Android 本机 Host 被误标成桌面项目）
    expect(info.workspaceSharedWithDesktop).toBe(true);
    expect(JSON.stringify(info)).not.toContain("token");
  });
});

describe("TR-1d 敏感读取的 approvalId 透传", () => {
  it("readWorkspace / diffWorkspace 带 approvalId 时进 params；不带时不出现在 params 里", async () => {
    const { calls, client } = fakeHostClient();
    const t = remoteTransport(client as never);

    await t.readWorkspace!(".env", 0, 200_000, "appr-1");
    await t.readWorkspace!(".env", 0, 200_000);
    await t.diffWorkspace!(".env", "HEAD", "appr-2");
    await t.diffWorkspace!(".env");

    expect(calls[0][0]).toBe("workspace.read");
    expect(calls[0][1]).toMatchObject({ path: ".env", approvalId: "appr-1" });
    expect(calls[1][1]).not.toHaveProperty("approvalId");
    expect(calls[2][0]).toBe("workspace.diff");
    expect(calls[2][1]).toMatchObject({ path: ".env", base: "HEAD", approvalId: "appr-2" });
    expect(calls[3][1]).not.toHaveProperty("approvalId");
  });
});

describe("TR-2 localTransport 不依赖渲染侧", () => {
  it("用注入的回调就能完整构造，hello 直接返回 hostId", async () => {
    const t: SessionTransport = localTransport({
      hostId: "local",
      listSessions: async () => [{ id: "a" }],
      getSession: async () => ({ title: "A", messages: [] }),
      send: async () => ({ runId: "r" }),
      cancel: async () => undefined,
      subscribe: () => () => undefined,
    });
    expect(await t.hello()).toEqual({ hostId: "local" });
    expect(await t.listSessions()).toEqual([{ id: "a" }]);
  });
});

describe("TR-3 能力位", () => {
  it("local 全开；remote 关终端/附件并标记多设备；remoteFull 只多设备", () => {
    const local = capabilitiesFor("local");
    expect(can(local, "terminal") && can(local, "attachments") && can(local, "cancelRun")).toBe(true);
    expect(local.multiDevice).toBe(false);
    const remote = capabilitiesFor("remote");
    expect(can(remote, "terminal")).toBe(false);
    expect(can(remote, "attachments")).toBe(false);
    expect(can(remote, "multiDevice")).toBe(true);
    expect(can(remote, "cancelRun")).toBe(true);
    const full = capabilitiesFor("remoteFull");
    expect(can(full, "terminal")).toBe(true);
    expect(can(full, "multiDevice")).toBe(true);
  });
});

describe("TR-4 写模式由 capabilities 决定（不是宿主标记）", () => {
  /** 网关 M2 的真实能力表（与 Rust 白名单/TS GATEWAY_RPC_METHODS 一致） */
  const GATEWAY_M2 = [
    "host.hello",
    "host.diagnostics",
    "session.list",
    "session.get",
    "prompt.send",
    "run.cancel",
    "approval.list",
    "approval.respond",
  ];
  /** M2 写路径第一批（只有发送/取消，没有事件与审批）：必须**如实退回只读** */
  const GATEWAY_FIRST_BATCH = [
    "host.hello",
    "host.diagnostics",
    "session.list",
    "session.get",
    "prompt.send",
    "run.cancel",
  ];

  it("M2 网关 = 写模式；只有发送/取消的早期网关 = 只读", () => {
    expect(canWriteSessions(GATEWAY_M2)).toBe(true);
    expect(canWriteSessions(GATEWAY_FIRST_BATCH)).toBe(false);
    // 旧 Host 不返回能力表：按远程第一版处理（升级兼容，不把正常 Host 降成只读）
    expect(canWriteSessions(null)).toBe(true);
    // 缺任意一条都不算写模式（半套 UI 的判据）
    for (const missing of ["prompt.send", "run.cancel", "approval.list", "approval.respond"]) {
      expect(
        canWriteSessions(GATEWAY_M2.filter((m) => m !== missing)),
        `缺 ${missing} 时不该开写入口`,
      ).toBe(false);
    }
  });

  it("能力位从方法表推导：M2 网关没有文件/附件/新建/终端；M3 网关开只读文件面 + 变更面", () => {
    const gateway = capabilitiesFromMethods(GATEWAY_M2);
    expect(gateway).toMatchObject({
      terminal: false,
      approvals: true,
      workspaceWrite: false,
      changes: false,
      attachments: false,
      cancelRun: true,
      createSession: false,
      projects: false,
      multiDevice: true,
    });

    // M3：只开 workspace.* ⇒ 文件树/预览/diff 可用，但变更记录仍不可用
    // （否则手机会看到一个点开必报 UNSUPPORTED 的「变更」页签）。
    const gatewayM3 = capabilitiesFromMethods([...GATEWAY_M2, "workspace.read", "workspace.list", "workspace.diff"]);
    expect(gatewayM3).toMatchObject({ workspaceWrite: true, changes: false });

    // M3 变更面：两条方法都开才画「变更」页签（网关与 Host 同一判据）。
    const gatewayM3Changes = capabilitiesFromMethods([
      ...GATEWAY_M2,
      "workspace.read",
      "workspace.list",
      "workspace.diff",
      "session.changes",
      "session.change.diff",
    ]);
    expect(gatewayM3Changes).toMatchObject({ workspaceWrite: true, changes: true });

    const host = capabilitiesFromMethods([
      ...GATEWAY_M2,
      "session.create",
      "project.list",
      "project.create",
      "workspace.read",
      "workspace.list",
      "workspace.diff",
      "attachment.put",
      "session.changes",
      "session.change.diff",
    ]);
    expect(host).toMatchObject({
      terminal: false,
      approvals: true,
      workspaceWrite: true,
      changes: true,
      attachments: true,
      cancelRun: true,
      createSession: true,
      projects: true,
    });
    // 只有 project.list 没有 project.create ⇒ 「能选项目、不能建项目」：
    // projects 是"两条都开"的派生位，避免手机画一个点了必失败的「新建项目」。
    expect(capabilitiesFromMethods([...GATEWAY_M2, "project.list"]).projects).toBe(false);

    // 空能力表（服务器什么都没开）= 全关，不是"默认全开"
    expect(capabilitiesFromMethods([])).toMatchObject({
      terminal: false,
      approvals: false,
      workspaceWrite: false,
      changes: false,
      attachments: false,
      cancelRun: false,
      createSession: false,
    });
  });
});

describe("TR-5 审批 RPC 透传", () => {
  it("listApprovals 调 approval.list；respondApproval 带 allow/deny", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      rpc: async (method: string, params?: unknown) => {
        calls.push([method, params]);
        if (method === "approval.list") {
          return {
            approvals: [
              { approvalId: "perm-1", tool: "bash", summary: "command: ls", details: { command: "ls" } },
            ],
          };
        }
        return { ok: true };
      },
      connect: vi.fn(),
      close: vi.fn(),
      onEvent: () => () => undefined,
    };
    const t = remoteTransport(client as never);
    expect(await t.listApprovals!()).toEqual([
      { approvalId: "perm-1", tool: "bash", summary: "command: ls", details: { command: "ls" } },
    ]);
    await t.respondApproval!("perm-1", "deny", "approval-1");
    expect(calls).toEqual([
      ["approval.list", {}],
      ["approval.respond", { approvalId: "perm-1", decision: "deny", requestId: "approval-1" }],
    ]);
  });

  it("hello 透传 capabilities（写模式判据的来源）", async () => {
    const client = {
      rpc: async () => ({
        hostId: "gw",
        capabilities: { supported: ["prompt.send", "run.cancel"], unsupported: ["session.create"] },
      }),
      connect: vi.fn(),
      close: vi.fn(),
      onEvent: () => () => undefined,
    };
    const t = remoteTransport(client as never);
    expect(await t.hello()).toEqual({
      hostId: "gw",
      capabilities: { supported: ["prompt.send", "run.cancel"], unsupported: ["session.create"] },
    });
  });

  it("getSession 透传 run：页面重开后仍能拿到「停止」所需的 runId", async () => {
    const client = {
      rpc: async () => ({
        session: { title: "t" },
        messages: [],
        run: { runId: "run-live", state: "running" },
      }),
      connect: vi.fn(),
      close: vi.fn(),
      onEvent: () => () => undefined,
    };
    const t = remoteTransport(client as never);
    expect(await t.getSession("s1")).toEqual({
      title: "t",
      messages: [],
      run: { runId: "run-live", state: "running" },
    });

    // 旧 Host 不返回 run：保持 undefined，不要把"不知道"当成"没在跑"。
    const legacy = remoteTransport({
      rpc: async () => ({ session: { title: "t" }, messages: [] }),
      connect: vi.fn(),
      close: vi.fn(),
      onEvent: () => () => undefined,
    } as never);
    expect(await legacy.getSession("s1")).toEqual({ title: "t", messages: [] });
  });
});
