/**
 * 「最近检查」的记录与读取（第 233 轮 · 二次升级 Phase C 的数据源）。
 *
 * ## 为什么需要
 *
 * Inspector 要显示「本轮检查过什么、过没过」，而仓库里**没有任何地方**记过这件事 ——
 * 工具结果只活在消息流里，面板读不到。这里补一条**有界、可读、不落数据库**的记录：
 * 走设置面的 JSON（`codem-verification-checks`），每会话最多 `MAX_CHECKS` 条。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | VC-1 | 记录的会话能读回，且**新→旧**排序（面板先看最近的） |
 * | VC-2 | 只记 `{command, ok, at}`：命令截断 200 字符，**不存输出** |
 * | VC-3 | 有界：超过 `MAX_CHECKS` 只保留最近那批（设置面不许无限膨胀） |
 * | VC-4 | 会话隔离：A 会话的记录不会出现在 B 会话（否则会把别人的检查当自己的） |
 * | VC-5（反向对照） | 空 sessionId / 没有记录 ⇒ 返回空数组，不抛 |
 *
 * 变异自证：把截断去掉 ⇒ VC-2 红；把 `slice(-MAX_CHECKS)` 去掉 ⇒ VC-3 红。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import {
  listVerificationChecks,
  recordVerificationCheck,
  __resetVerificationChecksForTests,
  MAX_CHECKS,
} from "../core/environment/verification-checks";

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [] } }));
  __resetVerificationChecksForTests();
});

describe("最近检查的记录", () => {
  it("VC-1: 能读回，且新→旧排序", () => {
    recordVerificationCheck("s1", { command: "npx tsc --noEmit", ok: true });
    recordVerificationCheck("s1", { command: "npx vitest run", ok: false });

    const list = listVerificationChecks("s1");
    expect(list).toHaveLength(2);
    expect(list[0].command, "最新的排在最前").toBe("npx vitest run");
    expect(list[0].ok).toBe(false);
    expect(list[1].command).toBe("npx tsc --noEmit");
    expect(list[0].at, "要带时间戳（面板按时间解释顺序）").toBeGreaterThan(0);
  });

  it("VC-2: 命令截断到 200 字符，且不存输出", () => {
    const long = "x".repeat(500) + " --flag";
    recordVerificationCheck("s2", { command: long, ok: true });
    const [entry] = listVerificationChecks("s2");
    expect(entry.command.length, "命令必须截断").toBeLessThanOrEqual(200);
    expect(Object.keys(entry).sort(), "只许这三个字段（不存输出）").toEqual(["at", "command", "ok"]);
  });

  it("VC-3: 有界（超过上限只留最近 MAX_CHECKS 条）", () => {
    for (let i = 0; i < MAX_CHECKS + 7; i++) {
      recordVerificationCheck("s3", { command: `cmd-${i}`, ok: true });
    }
    const list = listVerificationChecks("s3");
    expect(list).toHaveLength(MAX_CHECKS);
    expect(list[0].command, "最新的仍在最前").toBe(`cmd-${MAX_CHECKS + 6}`);
    expect(list.some((c) => c.command === "cmd-0"), "最旧的应被挤掉").toBe(false);
  });

  it("VC-4: 会话隔离", () => {
    recordVerificationCheck("a", { command: "A 的检查", ok: true });
    recordVerificationCheck("b", { command: "B 的检查", ok: true });
    expect(listVerificationChecks("a").map((c) => c.command)).toEqual(["A 的检查"]);
    expect(listVerificationChecks("b").map((c) => c.command)).toEqual(["B 的检查"]);
  });

  it("VC-5（反向对照）: 空 sessionId / 无记录 ⇒ 空数组，不抛", () => {
    expect(listVerificationChecks("")).toEqual([]);
    expect(listVerificationChecks("never-recorded")).toEqual([]);
    expect(() => recordVerificationCheck("", { command: "x", ok: true })).not.toThrow();
  });
});
