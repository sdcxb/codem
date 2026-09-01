/**
 * 复现测试：清理 codem-db.bin 后，安全策略设置无法持久化/读取
 *
 * 用户报告：清理了 codem-db.bin（SQLite 数据库）后项目重新初始化，
 * 无论选择 ask/auto/full 都报"写入已被拒绝"，且 UI 显示与 engine 行为脱节。
 *
 * 怀疑点：DB 清理后 settings 表为空，setGlobalSecurityMode/setProjectSecurityMode
 * 写入后 getEffectiveSecurityMode 读不到，导致 App.tsx 的 securityMode state
 * 永远是默认 "ask" → tools.ts 永远走 ask 分支 → onWriteConfirm 被调用。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { initDatabase, resetDatabase } from "../core/storage/database";
import {
  getGlobalSecurityMode,
  setGlobalSecurityMode,
  getProjectSecurityMode,
  setProjectSecurityMode,
  getEffectiveSecurityMode,
} from "../core/permission/security-mode";
import { getSetting, setSetting } from "../core/storage/settings";

describe("复现：清理 DB 后安全策略读写", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
  });

  it("DB-RESET-001: 清理 DB 后全局默认 ask", () => {
    expect(getGlobalSecurityMode()).toBe("ask");
    expect(getEffectiveSecurityMode()).toBe("ask");
  });

  it("DB-RESET-002: 设置全局 full 后能立即读回", () => {
    setGlobalSecurityMode("full");
    expect(getGlobalSecurityMode()).toBe("full");
    expect(getEffectiveSecurityMode()).toBe("full");
    expect(getEffectiveSecurityMode("C:\\any\\project")).toBe("full");
  });

  it("DB-RESET-003: 设置项目级 full 后 getEffectiveSecurityMode(项目路径) 返回 full", () => {
    setProjectSecurityMode("C:\\repro-project", "full");
    expect(getProjectSecurityMode("C:\\repro-project")).toBe("full");
    expect(getEffectiveSecurityMode("C:\\repro-project")).toBe("full");
    // 其他项目不受影响 → 回退全局 ask
    expect(getEffectiveSecurityMode("C:\\other-project")).toBe("ask");
  });

  it("DB-RESET-004: 项目级设置后清除 → 回退全局", () => {
    setGlobalSecurityMode("full");
    setProjectSecurityMode("C:\\repro-project", "ask");
    expect(getEffectiveSecurityMode("C:\\repro-project")).toBe("ask");
    setProjectSecurityMode("C:\\repro-project", null);
    expect(getEffectiveSecurityMode("C:\\repro-project")).toBe("full");
  });

  it("DB-RESET-005: setSetting 持久化后 getSetting 能读回（settings 表读写链路）", () => {
    setSetting("codem-security-mode", "full");
    expect(getSetting("codem-security-mode")).toBe("full");
  });
});
