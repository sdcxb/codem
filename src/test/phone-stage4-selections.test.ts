/**
 * 阶段 4（远端改模型/权限档 + 多端在场感知）判据 —— S4-1..S4-10。
 *
 * ## 这个文件最重要的一条：远端**不能放宽**自己的权限档
 *
 * 阶段 0 建了一整套远端审批，目的是让"需要批准的工具"必须有人点同意。
 * 如果远端自己能把权限档改成 `full`（自动放行一切），它就**能自己授权自己** ——
 * 整套审批形同虚设。所以规则是**单向**的：收紧可以，放宽不行。
 *
 * 这条与 DSH 不同（它允许远端改权限）。差异是**有意的**，理由写在
 * `remote-selections.ts` 的文件头里，S4-4 把它钉住。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | S4-1 | 权限档严格程度有全序，未知档位一律按"放宽"处理（fail-closed） |
 * | S4-2 | 收紧/不变 ⇒ 允许；放宽 ⇒ 拒绝 |
 * | S4-3 | 拒绝时必须说清**为什么**与**怎么办**（不是含糊的"不允许"） |
 * | S4-4 | 判定必须在**服务端**做（界面自己猜规则 = 可绕过） |
 * | S4-5 | 目录接口给出模型与权限档，且每个档位带 `remoteAllowed` |
 * | S4-6 | 在场：远端活跃会刷新；超过 TTL 视为**已离开**（不许显示假在线） |
 * | S4-7 | 在场：重复活跃（同一设备同一会话）**不产生**事件（否则事件流会被刷满） |
 * | S4-8 | 在场：换了会话 ⇒ 视为变化（审批场景下这一条最有用） |
 * | S4-9 | 身份必须来自鉴权结果，**不许**从请求体里读客户端自称的 id |
 * | S4-10 | 手机页面有模型/权限选择入口与在场提示 |
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  isLoosening,
  verdictForRemoteSecurityChange,
  SECURITY_ORDER,
} from "../core/phone-link/remote-selections";
import {
  noteRemoteSeen,
  getPresence,
  pruneRemotes,
  REMOTE_TTL_MS,
  __resetPresenceForTests,
  __seedRemoteForTests,
} from "../core/phone-link/presence";
import { __resetPhoneEventsForTests, currentSeq } from "../core/phone-link/event-stream";

const read = (p: string) => readFileSync(p, "utf8");
const PHONE_LINK = "src/core/phone-link/phone-link.ts";

beforeEach(() => {
  __resetPresenceForTests();
  __resetPhoneEventsForTests();
});

describe("第 122 轮阶段 4 · 远端选择与在场", () => {
  it("S4-1: 严格程度有全序；**未知档位一律按放宽处理**（fail-closed）", () => {
    expect(SECURITY_ORDER.ask).toBeLessThan(SECURITY_ORDER.auto);
    expect(SECURITY_ORDER.auto).toBeLessThan(SECURITY_ORDER.full);

    // 收紧
    expect(isLoosening("full", "auto")).toBe(true === false ? true : false); // full→auto 是收紧
    expect(isLoosening("full", "ask")).toBe(false);
    expect(isLoosening("auto", "ask")).toBe(false);
    // 放宽
    expect(isLoosening("ask", "auto")).toBe(true);
    expect(isLoosening("ask", "full")).toBe(true);
    expect(isLoosening("auto", "full")).toBe(true);
    // 不变
    expect(isLoosening("ask", "ask")).toBe(false);

    /**
     * 未知档位（拼错的、将来新增而我们不认识的）必须按**放宽**处理 ——
     * 也就是拒绝。宁可多拒一次让用户去电脑上改，也不放行一个我们看不懂的档位。
     */
    expect(isLoosening("ask", "yolo")).toBe(true);
    expect(isLoosening("yolo", "ask")).toBe(true);
    expect(isLoosening("", "ask")).toBe(true);
  });

  it("S4-2/S4-3: 收紧放行、放宽拒绝，且拒绝时说清「为什么 + 怎么办」", () => {
    const t = verdictForRemoteSecurityChange("full", "ask");
    expect(t.ok).toBe(true);
    expect(t.ok === true && t.kind).toBe("tighten");

    const same = verdictForRemoteSecurityChange("auto", "auto");
    expect(same.ok === true && same.kind).toBe("same");

    const loose = verdictForRemoteSecurityChange("ask", "full");
    expect(loose.ok).toBe(false);
    if (loose.ok === false) {
      expect(loose.code).toBe("remote_cannot_loosen");
      // 要说清**为什么**（会自己取消对自己的监督）
      expect(loose.message).toMatch(/自己取消对自己的监督|自动通过/);
      // 还要说清**怎么办**（去电脑上改）—— 含糊的"不允许"没用
      expect(loose.message).toMatch(/电脑/);
    }
  });

  it("S4-4: 判定必须在**服务端**做（界面自己猜规则 = 可绕过）", () => {
    const src = read(PHONE_LINK);
    // 路由里必须调用服务端判定
    expect(src).toContain("verdictForRemoteSecurityChange(");
    // 且拒绝时返回 403（如实拒绝，不是 200 带个字段）
    const idx = src.indexOf("const verdict = verdictForRemoteSecurityChange(");
    expect(idx).toBeGreaterThan(0);
    const after = src.slice(idx, idx + 700);
    expect(after, "拒绝必须回 403").toContain("403");
    expect(after, "拒绝要把原因回给客户端").toContain("message: verdict.message");
    /**
     * 反向判据：**不许**只看客户端传来的 `remoteAllowed` 之类字段就放行 ——
     * 那等于把闸门的钥匙交给请求方。服务端必须是唯一判定者。
     */
    expect(src).not.toMatch(/if\s*\(\s*body\.remoteAllowed/);
  });

  it("S4-5: 目录接口同时给模型与权限档，且每档带 remoteAllowed", () => {
    const src = read(PHONE_LINK);
    expect(src).toContain("case \"catalog\"");
    expect(src, "模型来自当前执行模式的目录（与桌面同一个来源）").toContain("getConfiguredApiModels()");
    expect(src).toContain("MIMO_MODELS");
    expect(src, "每个权限档都要带 remoteAllowed（界面据此禁用不可选项）").toContain("remoteAllowed:");
    // 目录必须报出**作用域**：我们改的是项目级/全局，不是 DSH 的会话级
    expect(src, "必须如实说明改动作用域").toContain("scope:");
  });

  it("S4-6: 在场 —— 活跃会刷新；超过 TTL 视为**已离开**（不许假在线）", () => {
    const t0 = 1_000_000;
    __seedRemoteForTests({ deviceId: "dev-1", ip: "192.168.1.5", lastSeenMs: t0, sessionId: "s-1" });
    // TTL 内：在线
    let p = getPresence(t0 + REMOTE_TTL_MS - 1);
    expect(p.remoteCount).toBe(1);
    expect(p.desktop).toBe(true);
    // 超过 TTL：必须消失
    p = getPresence(t0 + REMOTE_TTL_MS + 1);
    expect(p.remoteCount, "过期的远端必须从在场里消失（否则是假在线）").toBe(0);
    expect(p.remotes).toEqual([]);

    // pruneRemotes 的返回值要如实（S4-7 靠它决定推不推事件）
    __seedRemoteForTests({ deviceId: "dev-2", ip: "", lastSeenMs: t0 });
    expect(pruneRemotes(t0 + 10)).toBe(false);
    expect(pruneRemotes(t0 + REMOTE_TTL_MS + 1)).toBe(true);
  });

  it("S4-7: 重复活跃**不产生**事件；只集合真的变了才推", () => {
    const first = noteRemoteSeen("dev-1", "10.0.0.2", "s-1");
    expect(first, "第一次见到这台设备 ⇒ 是变化").toBe(true);
    const before = currentSeq();
    // 同一台、同一会话、TTL 内重复上报 ⇒ 不该算变化
    for (let i = 0; i < 5; i++) {
      expect(noteRemoteSeen("dev-1", "10.0.0.2", "s-1")).toBe(false);
    }
    expect(currentSeq(), "重复活跃不该产生事件（否则事件流会被刷满）").toBe(before);

    // 新设备 ⇒ 变化
    expect(noteRemoteSeen("dev-2", "10.0.0.3", "s-1")).toBe(true);
    // TTL 过期后重现 ⇒ 也是变化（界面要重新显示它）
    const t = Date.now();
    __seedRemoteForTests({ deviceId: "dev-9", ip: "10.0.0.9", lastSeenMs: t - REMOTE_TTL_MS - 1 });
    expect(noteRemoteSeen("dev-9", "10.0.0.9", undefined)).toBe(true);
  });

  it("S4-8: 换了会话 ⇒ 视为变化（审批场景下这一条最有用）", () => {
    noteRemoteSeen("dev-1", "10.0.0.2", "s-1");
    expect(noteRemoteSeen("dev-1", "10.0.0.2", "s-2"), "换会话要算变化").toBe(true);
    expect(noteRemoteSeen("dev-1", "10.0.0.2", "s-2")).toBe(false);
    // IP 变了也算（同一设备换了网络）
    expect(noteRemoteSeen("dev-1", "10.0.0.99", "s-2")).toBe(true);
    // 在场视图里能看到它在看哪个会话
    expect(getPresence().remotes[0].sessionId).toBe("s-2");
  });

  it("S4-9: 身份来自**鉴权结果**，不许读客户端自称的 id", () => {
    const src = read(PHONE_LINK);
    // Rust 侧要把它转过来
    const rs = read("src-tauri/src/phone/mod.rs");
    expect(rs, "Rust 侧必须把已鉴权设备身份转给渲染进程").toContain('"deviceId": device.as_ref().map');
    /**
     * 关键不是"两个东西都在文件里"，而是**顺序**：传给 `proxy_to_ts` 的那个设备
     * 必须是 `auth_device(...)` 查出来的那一个。
     *
     * ⚠️ 第一版用的是"两者相距 < 200 字符"的邻近断言 —— 我自己后来在这中间
     * 加了一段注释就把它撑破了，红得毫无意义。**顺序判据不会因为加了注释而失效**，
     * 而它守的正是那个真正的性质。
     */
    const authIdx = rs.indexOf("auth_device(&g.devices");
    const passIdx = rs.indexOf("proxy_to_ts(app, st, req, Some((device.id");
    expect(authIdx, "必须调用 auth_device 做鉴权").toBeGreaterThan(0);
    expect(passIdx, "必须把鉴权得到的设备传给 proxy_to_ts").toBeGreaterThan(0);
    expect(passIdx, "传给 proxy_to_ts 的设备必须在鉴权之后才拿到").toBeGreaterThan(authIdx);
    // 而那个 `Some((device.id` 用的必须是上面 `let Some(device) = device` 绑定的变量
    expect(rs).toMatch(/let Some\(device\) = device else \{[\s\S]{0,200}?unauthorized/);
    // 渲染侧用请求里带来的（来自 Rust），**不从 body 读**
    expect(src).toContain("req.deviceId");
    expect(src, "不许从请求体里取 deviceId（那是冒充入口）").not.toMatch(/body\.deviceId/);
    // 在场记录必须发生在 events 路由（长轮询是最可靠的在场信号）
    const evIdx = src.indexOf('case "events"');
    const evBlock = src.slice(evIdx, evIdx + 900);
    expect(evBlock, "events 路由必须登记在场").toContain("noteRemoteSeen(");
  });

  it("S4-10: 手机页面有模型/权限选择入口与在场提示", () => {
    const html = read("src-tauri/src/phone/ui/app.html");
    expect(html, "要能读目录").toContain("/api/catalog");
    expect(html, "要能提交选择").toContain("/api/selections");
    expect(html, "要有在场提示").toContain("/api/presence");
    // 权限档被拒时必须把服务端给的原因显示出来（不是笼统报错）
    expect(html).toMatch(/remoteAllowed|不能再放宽|只能收紧/);
  });

  it("S4-11: 桌面侧也显示在场（双方互相可见，不是单向）", () => {
    const ui = read("src/components/PhoneLinkSettings.tsx");
    expect(ui, "桌面必须显示在场").toContain('data-testid="phone-presence"');
    expect(ui).toContain("getPresence");
    // 必须**直接读进程内状态**，不为显示自己而发 HTTP 请求（那是一次无意义的自我往返）
    expect(ui, "桌面读在场不该走 HTTP").not.toContain('api("/api/presence"');
    // 没有远端时要**说没有**（而不是留一片空白让人以为坏了）
    expect(ui).toMatch(/没有远端设备在查看|No remote device/);
    // 有远端时要说清"是哪台 / 在看哪个会话"—— 审批场景下这才有意义
    expect(ui).toMatch(/remotes\.map/);
    expect(ui).toMatch(/sessionId/);
  });
});
