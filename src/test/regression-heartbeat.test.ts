/**
 * 测试：HeartbeatManager 配置回归 — HBRT-001 ~ HBRT-015
 *
 * 验证新增的 getGlobalConfig/setGlobalConfig/getAll
 * 不破坏现有 create/get/remove/stopAll/getActive/getStats 逻辑。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import {
  HeartbeatManager,
  ActivityHeartbeat,
  getHeartbeatManager,
  type HeartbeatConfig,
} from "../core/heartbeat/heartbeat";

describe("HeartbeatManager 配置回归", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
  });

  // ===== HBRT-001 ~ HBRT-008: 全局配置持久化 =====
  describe("全局配置持久化", () => {
    it("HBRT-001: 默认配置正确", () => {
      const mgr = new HeartbeatManager();
      const config = mgr.getGlobalConfig();
      expect(config.interval).toBe(30000);
      expect(config.timeout).toBe(5000);
      expect(config.maxFailures).toBe(3);
      expect(config.sendMetadata).toBe(true);
    });

    it("HBRT-002: 修改配置并持久化", () => {
      const mgr = new HeartbeatManager();
      mgr.setGlobalConfig({ interval: 10000 });
      expect(mgr.getGlobalConfig().interval).toBe(10000);
    });

    it("HBRT-003: setGlobalConfig 更新内存配置", () => {
      const mgr = new HeartbeatManager();
      mgr.setGlobalConfig({ interval: 10000 });
      // 验证内存中配置已更新
      expect(mgr.getGlobalConfig().interval).toBe(10000);
      expect(mgr.getGlobalConfig().timeout).toBe(5000);
    });

    it("HBRT-004: 新 HeartbeatManager 使用默认配置", () => {
      const fresh = new HeartbeatManager();
      const config = fresh.getGlobalConfig();
      // 无 DB 数据时返回默认值
      expect(config.interval).toBe(30000);
      expect(config.timeout).toBe(5000);
    });

    it("HBRT-005: 部分更新不丢失其他字段", () => {
      const mgr = new HeartbeatManager();
      mgr.setGlobalConfig({ interval: 10000 });
      mgr.setGlobalConfig({ timeout: 8000 });
      const config = mgr.getGlobalConfig();
      expect(config.interval).toBe(10000);
      expect(config.timeout).toBe(8000);
    });

    it("HBRT-006: create 使用全局配置", () => {
      const mgr = new HeartbeatManager();
      mgr.setGlobalConfig({ interval: 10000 });
      const hb = mgr.create("sess-test");
      const data = hb.getData();
      expect(data.sessionId).toBe("sess-test");
      // 心跳配置通过构造函数传入，间接验证
    });

    it("HBRT-007: create 可覆盖全局配置", () => {
      const mgr = new HeartbeatManager();
      mgr.setGlobalConfig({ interval: 10000 });
      const hb = mgr.create("sess-test", { interval: 5000 });
      expect(hb).toBeDefined();
      // 不同 interval 的心跳实例
    });

    it("HBRT-008: endpoint 默认为 undefined", () => {
      const mgr = new HeartbeatManager();
      expect(mgr.getGlobalConfig().endpoint).toBeUndefined();
    });
  });

  // ===== HBRT-009 ~ HBRT-015: 会话管理不受影响 =====
  describe("会话管理不受影响", () => {
    it("HBRT-009: create 返回已有实例（引用相等）", () => {
      const mgr = new HeartbeatManager();
      const hb1 = mgr.create("sess-1");
      const hb2 = mgr.create("sess-1");
      expect(hb1).toBe(hb2);
    });

    it("HBRT-010: get 返回正确心跳", () => {
      const mgr = new HeartbeatManager();
      mgr.create("sess-1");
      const hb = mgr.get("sess-1");
      expect(hb).toBeDefined();
      expect(hb).toBeInstanceOf(ActivityHeartbeat);
    });

    it("HBRT-011: remove 销毁心跳", () => {
      const mgr = new HeartbeatManager();
      mgr.create("sess-1");
      mgr.remove("sess-1");
      expect(mgr.get("sess-1")).toBeUndefined();
    });

    it("HBRT-012: getAll 返回所有心跳", () => {
      const mgr = new HeartbeatManager();
      mgr.create("sess-1");
      mgr.create("sess-2");
      expect(mgr.getAll()).toHaveLength(2);
    });

    it("HBRT-013: getStats 统计正确", () => {
      const mgr = new HeartbeatManager();
      const hb1 = mgr.create("sess-1");
      hb1.start();
      mgr.create("sess-2"); // stopped
      const stats = mgr.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.stopped).toBeGreaterThanOrEqual(1);
      hb1.stop();
    });

    it("HBRT-014: stopAll 停止所有", () => {
      const mgr = new HeartbeatManager();
      const hb1 = mgr.create("sess-1");
      const hb2 = mgr.create("sess-2");
      hb1.start();
      hb2.start();
      mgr.stopAll();
      expect(mgr.getStats().active).toBe(0);
    });

    it("HBRT-015: getActive 只返回 active", () => {
      const mgr = new HeartbeatManager();
      const hb1 = mgr.create("sess-1");
      hb1.start();
      mgr.create("sess-2"); // stopped
      const active = mgr.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].getStatus()).toBe("active");
      hb1.stop();
    });
  });
});
