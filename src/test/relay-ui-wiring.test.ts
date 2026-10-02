/**
 * 第 122 轮 §11D（远程中继的设置界面）判据。
 *
 * ## 这个文件最主要守的一件事：**界面不许撒谎**
 *
 * 中继这条路上，"看起来连上了"和"真的连上了"差别很大：桌面是**主动连出去**的，
 * 连不上时它会一直按 3 秒重试 —— 如果没有明确的失败态，用户的体验就是
 * "一直转圈"，既不知道有没有成功，也不知道为什么失败。
 *
 * 所以核心判据是 `relayPhase` 的四态压缩，以及界面**只从它取措辞**。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | RUI-1 | 四态互斥且优先级正确：**"在跑"绝不等于"已连接"**；有错误必须报错误 |
 * | RUI-2 | 状态透传不编造（缺字段就是 false/空，不给"看起来合理"的默认） |
 * | RUI-3 | 界面真的能启停（调用的是那两个命令） |
 * | RUI-4 | connectorId 与**失败原因**必须显示出来（带 testid，真机脚本可定位） |
 * | RUI-5 | 措辞绑定在 phase 上，不许写死"已连接" |
 * | RUI-6 | "用户是否改过地址"只存**一处真相**（ref），否则输入框会被轮询改回去 |
 * | RUI-7 | 地址为空时不能点启动 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeRelay, relayPhase } from "../core/phone-link/phone-link";

const read = (p: string) => readFileSync(p, "utf8");
const UI = "src/components/PhoneLinkSettings.tsx";

/** 造一个"已连接"的基准状态，再按需覆盖 */
const base = {
  running: true,
  connected: true,
  serverUrl: "https://relay.example.com",
  connectorId: "cn-abc",
  lastError: null as string | null,
  lastBeatMs: 1,
  requestsServed: 0,
  errors: 0,
  reconnects: 0,
  reconnectSeconds: 3,
};

describe("第 122 轮 §11D · 远程中继设置界面", () => {
  it("RUI-1: 四态优先级正确 —— 「在跑」绝不等于「已连接」", () => {
    expect(relayPhase(base)).toBe("connected");
    // 关掉就是关掉（即使残留 connected=true 也不许说已连接）
    expect(relayPhase({ ...base, running: false })).toBe("stopped");
    expect(relayPhase({ ...base, running: false, connected: false })).toBe("stopped");

    /**
     * 关键：`running=true, connected=false` —— 这正是"桌面在按 3 秒重连"的常态。
     * 它**必须**是 connecting，绝不能是 connected。
     */
    expect(relayPhase({ ...base, connected: false })).toBe("connecting");
    // 有错误 ⇒ 报错误（把原因显示出来），而不是含糊的 connecting
    expect(relayPhase({ ...base, connected: false, lastError: "连中继失败: ECONNREFUSED" })).toBe("error");
    // 已连上时旧错误不该盖过"已连接"（错误是历史，连接是现状）
    expect(relayPhase({ ...base, connected: true, lastError: "上一次失败" })).toBe("connected");
  });

  it("RUI-2: 状态透传不编造（缺字段就是 false/空）", () => {
    const empty = normalizeRelay(null);
    expect(empty.running).toBe(false);
    expect(empty.connected).toBe(false);
    expect(empty.serverUrl).toBe("");
    expect(empty.connectorId).toBe("");
    expect(empty.lastError).toBeNull();
    // reconnectSeconds 给默认是**可以**的：它是"多久重试一次"的说明性数值，
    // 而 running/connected 这种**事实**绝不许编
    expect(empty.reconnectSeconds).toBe(3);

    const full = normalizeRelay({ ...base, requestsServed: 7, errors: 2, reconnects: 1 });
    expect(full.requestsServed).toBe(7);
    expect(full.errors).toBe(2);
    expect(full.reconnects).toBe(1);
    expect(full.connectorId).toBe("cn-abc");
  });

  it("RUI-3/RUI-7: 界面能启停，且地址为空时点不动", () => {
    const ui = read(UI);
    expect(ui).toContain('tauriInvoke("phone_relay_start"');
    expect(ui).toContain('tauriInvoke("phone_relay_stop"');
    expect(ui).toContain('tauriInvoke("phone_relay_status"');
    // 空地址不许触发启动
    expect(ui).toMatch(/disabled=\{busy \|\| !relayUrl\.trim\(\)\}/);
    // 运行时输入框禁用（避免改了地址却没生效的错觉）
    expect(ui).toMatch(/disabled=\{relay\.running\}/);
  });

  it("RUI-4: connectorId 与失败原因都要显示（带 testid）", () => {
    const ui = read(UI);
    expect(ui).toContain('data-testid="relay-phase"');
    expect(ui).toContain("relay.connectorId");
    expect(ui).toContain('data-testid="relay-error"');
    expect(ui).toContain("relay.lastError");
  });

  it("RUI-5: 措辞绑定在 phase 上，**不许写死「已连接」**", () => {
    const ui = read(UI);
    // 必须从 phase 推导
    expect(ui).toContain("relayPhase(relay)");
    // phase 必须落到 DOM 上（真机脚本据此断言，而不是匹配文案）
    expect(ui).toContain("data-phase={rPhase}");
    /**
     * ⚠️ 这条判据**第一版是假绿的**，变异 4 当场打脸 —— 记档。
     *
     * 第一版是"取 `"已连接"` 前面 400 个字符，看里面有没有 `rPhase === "connected"`"。
     * 变异把标签的条件换成 `true`（即无条件显示"已连接"）之后**照样全绿** ——
     * 因为那 400 字符里恰好还有**另一处** `rPhase === "connected"`（在颜色变量里）。
     *
     * 结论：**"附近出现过"不等于"就是它在把关"**。断言必须钉在
     * **条件与它守护的那个表达式之间的直接形状**上。
     */
    expect(
      ui,
      "「已连接」必须紧跟在自己的 phase 条件之后（不是附近有就算）",
    ).toMatch(/rPhase === "connected"\s*\n\s*\? \(zh \? "已连接"/);
    // 反向：不许被任何恒真条件或者别的条件把关
    expect(ui, "不许用恒真条件把关「已连接」").not.toMatch(/true\s*\n\s*\? \(zh \? "已连接"/);
    // 「连接失败」同理，必须由 error 分支把关
    expect(ui).toMatch(/rPhase === "error"\s*\n\s*\? \(zh \? "连接失败/);
  });

  it("RUI-6: 「用户是否改过地址」只存一处真相（ref），否则输入框会被轮询改回去", () => {
    const ui = read(UI);
    expect(ui).toContain("relayTouchedRef");
    // 不许同时又存一个 relayTouched state（两处真相必然分叉）
    expect(ui).not.toMatch(/const \[relayTouched, setRelayTouched\]/);
    // 轮询写回时必须先问用户有没有动过
    expect(ui).toMatch(/relayTouchedRef\.current \? cur : next\.serverUrl/);
  });
});
