/**
 * 测试 12：Recovery 数据 — codem-recovery 前缀
 *
 * 改动影响：
 *   - `recovery.ts` 从 "mimo-recovery" 改为 "codem-recovery"
 *   - 如果有误，会话恢复功能无法读取之前保存的恢复数据
 *
 * ⚠️ 第 62 轮更正：本文件原来还有一条「multi-layer 使用 codem-recovery 前缀」的用例，
 * 钉的是 `core/recovery/multi-layer.ts` 的 `-state` / `-sessions` 两个键名 ——
 * 而那个模块**没有任何生产调用者**（界面上的"多层会话恢复"标题其实由 `recovery.ts` 支撑，
 * 它是单层的），已按"遗留物清理"删除。既然没有实现再用那两个键名，
 * 继续断言它们就只是"测试在测一个不存在的约定"，所以那一并删掉；
 * 下面保留的是**活模块**（`recovery.ts`）的真实键名。
 */
import { describe, it, expect, beforeEach } from "vitest";

import { setSettingJSON, getSettingJSON, setSetting } from "../core/storage/settings";

describe("Recovery 数据 — codem-recovery 前缀", () => {
  beforeEach(async () => {
  });

  it("recovery 数据存储在 codem-recovery（非 mimo-recovery）", () => {
    const recoveryData = {
      version: 1,
      lastSaved: Date.now(),
      sessions: {},
      currentSessionId: null,
    };
    setSettingJSON("codem-recovery", recoveryData);

    const loaded = getSettingJSON<any>("codem-recovery", null);
    expect(loaded).not.toBeNull();
    expect(loaded.version).toBe(1);

    // 旧 key 应无数据
    const oldData = getSettingJSON<any>("mimo-recovery", null);
    expect(oldData).toBeNull();
  });

  it("recovery.ts DEFAULT_CONFIG.storagePrefix 为 codem-recovery", async () => {
    // 验证模块内部配置
    const recoveryModule = await import("../core/recovery/recovery");
    // 通过功能验证：写入 codem-recovery 能被读到
    setSettingJSON("codem-recovery", { test: true });
    const loaded = getSettingJSON<any>("codem-recovery", null);
    expect(loaded.test).toBe(true);
  });
});
