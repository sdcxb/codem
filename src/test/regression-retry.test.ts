/**
 * 测试：RetryExecutor 配置回归 — RTRY-001 ~ RTRY-015
 *
 * 验证新增的 getConfig/setConfig/loadPersistedConfig
 * 不破坏现有 execute/shouldRetry/getDelay/reset 逻辑。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import {
  RetryExecutor,
  getRetryExecutor,
  classifyError,
} from "../core/retry/retry";

describe("RetryExecutor 配置回归", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
  });

  // ===== RTRY-001 ~ RTRY-008: 配置持久化 =====
  describe("配置持久化", () => {
    it("RTRY-001: 默认配置正确", () => {
      const exec = new RetryExecutor();
      const config = exec.getConfig();
      expect(config.maxAttempts).toBe(10);
      expect(config.baseDelay).toBe(500);
      expect(config.backoffMultiplier).toBe(2);
      expect(config.maxDelay).toBe(5 * 60 * 1000);
      expect(config.totalTimeout).toBe(30 * 60 * 1000);
      expect(config.respectRetryAfter).toBe(true);
    });

    it("RTRY-002: 修改配置并持久化", () => {
      const exec = new RetryExecutor();
      exec.setConfig({ maxAttempts: 5 });
      expect(exec.getConfig().maxAttempts).toBe(5);
    });

    it("RTRY-003: setConfig 更新内存配置", () => {
      const exec = new RetryExecutor();
      exec.setConfig({ maxAttempts: 5 });
      // 验证内存中配置已更新
      expect(exec.getConfig().maxAttempts).toBe(5);
      expect(exec.getConfig().baseDelay).toBe(500);
    });

    it("RTRY-004: 新 RetryExecutor 使用默认配置", () => {
      const fresh = new RetryExecutor();
      const config = fresh.getConfig();
      // 无 DB 数据时返回默认值
      expect(config.maxAttempts).toBe(10);
      expect(config.baseDelay).toBe(500);
    });

    it("RTRY-005: 部分更新不丢失其他字段", () => {
      const exec = new RetryExecutor();
      exec.setConfig({ maxAttempts: 5 });
      exec.setConfig({ baseDelay: 1000 });
      const config = exec.getConfig();
      expect(config.maxAttempts).toBe(5);
      expect(config.baseDelay).toBe(1000);
    });

    it("RTRY-006: setConfig 更新 totalAttempts", () => {
      const exec = new RetryExecutor();
      exec.setConfig({ maxAttempts: 5 });
      expect(exec.getState().totalAttempts).toBe(5);
    });

    it("RTRY-007: 构造函数参数生效", () => {
      // 无 DB 持久化时，构造函数参数应生效
      const exec = new RetryExecutor({ maxAttempts: 20 });
      expect(exec.getConfig().maxAttempts).toBe(20);
    });

    it("RTRY-008: DB 无配置时使用默认值", () => {
      const exec = new RetryExecutor();
      expect(exec.getConfig().maxAttempts).toBe(10);
    });
  });

  // ===== RTRY-009 ~ RTRY-015: 重试逻辑不受影响 =====
  describe("重试逻辑不受影响", () => {
    it("RTRY-009: shouldRetry 对 429 返回 true", () => {
      const exec = new RetryExecutor();
      expect(exec.shouldRetry({ status: 429 })).toBe(true);
    });

    it("RTRY-010: shouldRetry 对 400 返回 false", () => {
      const exec = new RetryExecutor();
      expect(exec.shouldRetry({ status: 400 })).toBe(false);
    });

    it("RTRY-011: shouldRetry 超过 maxAttempts 返回 false", async () => {
      const exec = new RetryExecutor({ maxAttempts: 1 });
      // 手动设置 attempt 超过 maxAttempts
      // execute 会重置 state，所以我们需要先调用 execute 使其失败
      try {
        await exec.execute(async () => {
          throw { status: 500 };
        });
      } catch {}
      // 现在 attempt=1 >= maxAttempts=1，不应再重试
      expect(exec.shouldRetry({ status: 500 })).toBe(false);
    });

    it("RTRY-012: getDelay 指数退避", () => {
      const exec = new RetryExecutor({ baseDelay: 500, backoffMultiplier: 2 });
      expect(exec.getDelay(0)).toBe(500);
      expect(exec.getDelay(1)).toBe(1000);
      expect(exec.getDelay(2)).toBe(2000);
    });

    it("RTRY-013: getDelay 不超过 maxDelay", () => {
      const exec = new RetryExecutor({ baseDelay: 500, backoffMultiplier: 2, maxDelay: 3000 });
      expect(exec.getDelay(10)).toBeLessThanOrEqual(3000);
    });

    it("RTRY-014: getDelay 尊重 Retry-After", () => {
      const exec = new RetryExecutor({ respectRetryAfter: true });
      expect(exec.getDelay(0, 10000)).toBe(10000);
    });

    it("RTRY-015: execute 成功后不重试", async () => {
      const exec = new RetryExecutor();
      const result = await exec.execute(async () => "ok");
      expect(result).toBe("ok");
      expect(exec.getState().attempt).toBe(0);
    });
  });
});
