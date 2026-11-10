/**
 * 段式上下文开关 `segmentEpochs`（E3 / D1 / D11）。
 *
 * ## 为什么挂在 `codem-context-config` 而不是 `settings.isFeatureEnabled`
 *
 * E3 已拍板：这个开关跟着「压缩参数」走（同一个配置对象、同一个保存按钮），
 * 而不是走通用 feature-flag（`settings.ts:675` 自己写着那条通道当前零生产消费者）。
 *
 * ## 守什么
 *
 * 1. **默认 false**（2026-11-08 决定）：旧用户的 `codem-context-config` 里没有这个键，
 *    读出来必须是 true —— D11 的四条兼容判据已经全绿（见
 *    `segment-default-on-compat.test.ts`），门禁解除。这一点是 C13（用户不做上下文管理）
 *    与 C01（连续 Thread）的前提：默认配置下换段才真的会发生。
 * 2. **显式 false 仍回旧路径**：不切段（决策入口恒 none）、没有 switch epoch ⇒
 *    数据层不给分隔卡锚点、段诊断仍是第 1 段（「第 N 段」chip 不出现）。
 *    灰度回滚与对照实验都靠它。
 * 3. **可持久化**：面板保存后，新实例能读回；
 * 4. **面板真的有这个开关**：结构判据（本仓对 UI 接线的既有做法，见
 *    `completion-nudge-detail.test.ts:274` 的说明）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextManager } from "../core/context/context";
import { epochActionForLoop } from "../core/context/segment-switch";
import { createMessage } from "../core/storage/message";
import { segmentDiagnostics, segmentDividerAnchors } from "../core/storage/thread-history";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";

const SESSION = "sess-flag-off";

/** 预置一段普通历史（没有任何 epoch marker） */
function seedPlainHistory(count = 4) {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `flag-msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `第 ${i} 条`,
        timestamp: 1_000 + i,
        status: "done",
      },
      SESSION,
    );
  }
}

describe("segmentEpochs 灰度开关", () => {
  beforeEach(() => {
    /* 没有 Tauri 文件层 ⇒ 权威日志写入会走上报通道；这里只关心开关行为，静音掉噪声 */
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({}));
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("FLAG-1: 默认 false（旧配置里没有该键也一样；DEF-1 锁定）", () => {
    setSettingJSON("codem-context-config", { compactionThreshold: 0.7 });
    const cm = new ContextManager();
    expect(
      cm.getConfig().segmentEpochs,
      "默认必须是 false —— 2026-11-08 决定：不授权默认开启；显式 true 才切段",
    ).toBe(false);
  });

  it("FLAG-1b: 显式 {segmentEpochs:false} 时回到旧路径（不切段、无分隔锚点/段号 chip 输入）", () => {
    const cm = new ContextManager({ segmentEpochs: false });
    const cfg = cm.getConfig();
    expect(cfg.segmentEpochs, "显式关闭必须真的生效（灰度回滚的入口）").toBe(false);

    /**
     * ① 决策入口：旧路径下**任何**压力/连压/完成态都不许主张 switch。
     *    这是「不切段」的可执行定义（`trySwitchOnCompletion` 与两个中途入口都先看它）。
     */
    for (const options of [{}, { turnCompleted: true }]) {
      expect(
        epochActionForLoop(cfg, { contextPressure: 0.99, consecutiveCompactions: 9 }, options),
        `开关关闭时决策必须恒 none（options=${JSON.stringify(options)}）`,
      ).toBe("none");
    }
    /* 正向对照：同一个状态在开关打开时会 switch —— 证明上一条不是「恒 none」的空断言 */
    expect(
      epochActionForLoop({ segmentEpochs: true, compactionThreshold: 0.8 }, {
        contextPressure: 0.99,
        consecutiveCompactions: 0,
      }),
    ).toBe("switch");

    /**
     * ② 数据层：开关关着跑出来的会话没有任何 switch epoch ⇒
     *    `segmentDividerAnchors` 为空（不画分隔卡）、`segmentDiagnostics.segments === 1`
     *    （ChatPanel 的「已整理 · 第 N 段」chip 以 `segmentCount > 1` 为条件，因此也不出现）。
     */
    seedPlainHistory(4);
    expect(segmentDividerAnchors(SESSION), "没有 switch epoch ⇒ 不许有分隔锚点").toHaveLength(0);
    expect(segmentDiagnostics(SESSION)).toMatchObject({
      segments: 1,
      switches: 0,
      messages: 4,
    });
  });

  it("FLAG-2: updateConfig 持久化该键，新实例读回（显式 false 回滚也能存住）", () => {
    const cm = new ContextManager();
    cm.updateConfig({ segmentEpochs: false });

    const saved = getSettingJSON<Record<string, unknown> | null>("codem-context-config", null);
    expect(saved?.segmentEpochs, "必须真的写进 codem-context-config").toBe(false);

    const fresh = new ContextManager();
    expect(fresh.getConfig().segmentEpochs, "新实例（=重启后的形态）要读得回来").toBe(false);
  });

  it("FLAG-3: 设置面板里的开关真的绑定到该字段，且保存走 cm.updateConfig", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ContextMonitor.tsx"), "utf8");
    /* 光有字符串不够：注释/文案也会命中。这里钉**两个表达式**（读值 + 写值）。 */
    expect(src, "读值必须绑定 segmentEpochs").toContain("checked={ctxConfig.segmentEpochs === true}");
    expect(src, "写值必须回填到同一个字段").toContain(
      "setCtxConfig({ ...ctxConfig, segmentEpochs: e.target.checked })",
    );
    expect(src, "保存必须走规范路径 updateConfig").toContain("cm.updateConfig(ctxConfig)");
  });
});
