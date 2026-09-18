/**
 * 失败提示必须**常驻可见**，与流式状态无关（第 47 轮补，UI/UX 审计 P1）
 *
 * ## 守的缺陷
 *
 * "失败必须可见"是仓库级契约（`persist-failure.ts` 与 `App.tsx` 的注释都写着这一条），
 * 但它在界面上**实际上没有落地**：
 * - `reportPersistFailure` 的可见出口只有一条 → `addGuidanceMessage(...)`；
 * - 而 `guidanceMessages` 在界面上**唯一**的渲染点带着 `isSessionStreaming` 前置条件
 *   → 用户**空闲时**（大多数写失败发生的时刻）改会话标题失败、删项目失败、
 *   保存权限规则失败、新建会话写库失败，**界面什么都不显示**；
 * - 更糟的是那条通道的语义是"**用户引导**"：它被渲染成一条待接收的引导条，
 *   主按钮「立刻引导」→ `interruptForGuidance` → **中断正在生成的回复**，
 *   而这条告警从来没进过引导队列，点下去只是把 AI 的回答打断、什么都不注入。
 *
 * ## 守什么
 *
 * | 组 | 守什么 |
 * | --- | --- |
 * | `ALERT-1` | 失败提示进**自己的通道**（不是引导队列） |
 * | `ALERT-2` | 同一区域只保留一条，重复失败累计次数（磁盘满不刷屏） |
 * | `ALERT-3` | 两条语气分开：`persist`（重启会丢）与 `action`（这次没生效） |
 * | `ALERT-4` | 用户可以关掉它；关掉之后不再出现 |
 * | `ALERT-5` | **渲染不依赖流式状态** —— 空闲时也必须在树里（这条是缺陷的正面判据） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = join(__dirname, "..", "..");
const readCode = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ALERT：失败提示的常驻通道", () => {
  it("ALERT-1: 失败进 persistAlerts，**不进**引导队列（语义不该混）", async () => {
    const { useAppStore } = await import("../store");
    useAppStore.setState({ persistAlerts: [], guidanceMessages: [] });

    useAppStore.getState().addPersistAlert({
      area: "settings.setSetting",
      kind: "persist",
      message: "数据保存失败（settings.setSetting）：磁盘满。",
    });

    const s = useAppStore.getState();
    expect(s.persistAlerts.length, "必须进常驻通道").toBe(1);
    expect(s.persistAlerts[0].area).toBe("settings.setSetting");
    expect(s.persistAlerts[0].count).toBe(1);
    expect(
      s.guidanceMessages.length,
      "绝不许进引导队列 —— 那条队列只在流式期间渲染，且按钮会中断正在生成的回复",
    ).toBe(0);
  });

  it("ALERT-2: 同一区域重复失败 → 只保留一条并累计次数（磁盘满不刷屏）", async () => {
    const { useAppStore } = await import("../store");
    useAppStore.setState({ persistAlerts: [] });

    for (let i = 0; i < 4; i += 1) {
      useAppStore.getState().addPersistAlert({
        area: "session.updateSession",
        kind: "persist",
        message: `第 ${i + 1} 次失败`,
      });
    }

    const alerts = useAppStore.getState().persistAlerts;
    expect(alerts.length, "同区域合并成一条，不许刷屏").toBe(1);
    expect(alerts[0].count, "次数要如实累计（用户据此判断是不是持续性问题）").toBe(4);
    expect(alerts[0].message, "保留最新一条的文案").toContain("第 4 次失败");
  });

  it("ALERT-3: 不同区域各自成条；kind 区分'重启会丢'与'这次没生效'", async () => {
    const { useAppStore } = await import("../store");
    useAppStore.setState({ persistAlerts: [] });

    useAppStore.getState().addPersistAlert({ area: "a", kind: "persist", message: "A 写盘失败" });
    useAppStore.getState().addPersistAlert({ area: "b", kind: "action", message: "B 操作没生效" });

    const alerts = useAppStore.getState().persistAlerts;
    expect(alerts.length, "不同区域是两个独立的问题").toBe(2);
    expect(alerts.map((a) => a.kind).sort()).toEqual(["action", "persist"]);
  });

  it("ALERT-4: 用户可以关掉它，关掉后不再出现", async () => {
    const { useAppStore } = await import("../store");
    useAppStore.setState({ persistAlerts: [] });

    useAppStore.getState().addPersistAlert({ area: "x", kind: "persist", message: "X 失败" });
    const id = useAppStore.getState().persistAlerts[0].id;

    useAppStore.getState().dismissPersistAlert(id);

    expect(useAppStore.getState().persistAlerts.length, "关掉之后就是空的").toBe(0);
  });

  it("ALERT-5: 渲染**不依赖流式状态**（空闲时也必须在树里）—— 这是缺陷的正面判据", () => {
    const app = readCode("src/App.tsx");
    // ① 应用树里必须挂了这个组件
    expect(app, "必须渲染 PersistFailureBanner").toContain("<PersistFailureBanner />");
    // ② 它的渲染点**不许**带任何流式条件（那正是原来的缺陷）
    const around = app.slice(Math.max(0, app.indexOf("<PersistFailureBanner />") - 400), app.indexOf("<PersistFailureBanner />") + 60);
    expect(
      /isSessionStreaming|isStreaming/.test(around),
      "失败提示的渲染绝不能被 isStreaming 之类的条件挡住 —— 写失败绝大多数发生在用户空闲时",
    ).toBe(false);

    // ③ 三条最关键的失败上报必须走常驻通道（不许退回引导队列）
    const banner = readCode("src/components/PersistFailureBanner.tsx");
    expect(banner).toContain("persistAlerts");
    for (const area of ["session.create", "storage.unavailable"]) {
      expect(app, `${area} 必须走 addPersistAlert`).toContain(`area: "${area}"`);
    }
  });

  it("ALERT-6: 组件自身读的是 persistAlerts（不是 guidanceMessages）", () => {
    const banner = readCode("src/components/PersistFailureBanner.tsx");
    expect(banner).toContain("s.persistAlerts");
    expect(
      banner.includes("guidanceMessages"),
      "组件不许再碰引导队列 —— 那是'用户引导'的语义，不是'出错了'",
    ).toBe(false);
  });
});
