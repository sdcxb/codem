/**
 * R3-4.1: Snapshot Test Layer + Real-API E2E Test Layer
 *
 * 设计对标 DSH 的 6 层测试架构。
 *
 * DSH 测试分层：
 * 1. unit — 纯函数/类（无 IO）
 * 2. integration — 多单元组合 + mock IO
 * 3. snapshot — 固定输入的输出快照对比
 * 4. contract — 接口契约验证
 * 5. e2e — 端到端流程
 * 6. real-api — 真实 API 调用（需要 API key）
 *
 * 我们之前的测试集中在 unit + integration 层。
 * 本文件添加 snapshot + real-api 两层的基础设施。
 *
 * 使用方式：
 * - snapshot: import { snapshotTest } from "./r3-snapshot-tests"
 * - real-api: import { realApiE2E } from "./r3-snapshot-tests"
 */

import * as fs from "fs";
import * as path from "path";

// ========== Snapshot Test Layer ==========

/**
 * Snapshot 测试 — 对比函数输出与已存储的快照。
 *
 * 第一次运行时创建快照文件，后续运行对比。
 * 如果输出变化，测试失败并提示更新快照。
 *
 * 对标 DSH snapshot 测试层。
 */
export class SnapshotTest {
  private snapshotDir: string;

  constructor(snapshotDir: string = "__snapshots__") {
    this.snapshotDir = snapshotDir;
  }

  /**
   * 对比函数输出与快照。
   *
   * @param name 快照名称
   * @param input 输入数据
   * @param fn 要测试的函数
   * @returns 如果匹配则 true，否则 false
   */
  async snapshot<T>(
    name: string,
    fn: () => T | Promise<T>,
  ): Promise<{ passed: boolean; reason?: string }> {
    const snapshotPath = path.join(this.snapshotDir, `${name}.snap`);
    const result = await fn();

    // 序列化结果
    const serialized = typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2);

    // 如果快照不存在，创建它
    if (!fs.existsSync(snapshotPath)) {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      fs.writeFileSync(snapshotPath, serialized, "utf-8");
      return { passed: true, reason: "snapshot created" };
    }

    // 对比
    const existing = fs.readFileSync(snapshotPath, "utf-8");
    if (existing === serialized) {
      return { passed: true };
    }

    return {
      passed: false,
      reason: `snapshot mismatch:\n--- expected ---\n${existing.slice(0, 500)}\n--- actual ---\n${serialized.slice(0, 500)}`,
    };
  }

  /**
   * 更新快照 — 删除现有快照让它重新创建。
   */
  updateSnapshot(name: string): void {
    const snapshotPath = path.join(this.snapshotDir, `${name}.snap`);
    if (fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }
  }
}

// ========== Real-API E2E Test Layer ==========

/**
 * Real-API E2E 测试 — 使用真实 LLM API 进行端到端测试。
 *
 * 需要环境变量 CODEM_TEST_API_KEY 设置。
 * 如果未设置，测试会被跳过（不是失败）。
 *
 * 对标 DSH real-api 测试层。
 */
export class RealApiE2E {
  /**
   * 检查是否可以运行 real-API 测试。
   */
  static isAvailable(): boolean {
    return !!process.env.CODEM_TEST_API_KEY || !!process.env.OPENAI_API_KEY;
  }

  /**
   * 运行一个 real-API 测试。
   * 如果 API key 不可用，跳过。
   */
  static async run(
    name: string,
    fn: () => Promise<void>,
  ): Promise<{ status: "passed" | "failed" | "skipped"; reason?: string }> {
    if (!this.isAvailable()) {
      return { status: "skipped", reason: "CODEM_TEST_API_KEY not set" };
    }

    try {
      await fn();
      return { status: "passed" };
    } catch (e: any) {
      return { status: "failed", reason: e.message };
    }
  }
}

// ========== Test Helpers ==========

/**
 * 创建一个临时事件日志用于测试。
 * 返回一个内存中的事件数组 + 操作函数。
 */
export function createTempEventLog() {
  const events: Array<{
    seq: number;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: number;
  }> = [];
  let nextSeq = 1;

  return {
    append(sessionId: string, type: string, payload: Record<string, unknown>) {
      const event = {
        seq: nextSeq++,
        sessionId,
        type,
        payload,
        timestamp: Date.now(),
      };
      events.push(event);
      return event;
    },
    readAll(sessionId: string) {
      return events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.seq - b.seq);
    },
    readRange(sessionId: string, from: number, to: number) {
      return events
        .filter((e) => e.sessionId === sessionId && e.seq >= from && e.seq <= to)
        .sort((a, b) => a.seq - b.seq);
    },
    count(sessionId: string) {
      return events.filter((e) => e.sessionId === sessionId).length;
    },
    clear() {
      events.length = 0;
      nextSeq = 1;
    },
  };
}
