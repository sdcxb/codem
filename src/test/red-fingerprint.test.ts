import { describe, expect, it } from "vitest";
import { RedFingerprintGuard } from "../core/llm/red-fingerprint";

const red = ["src/test/a.test.ts"];

describe("RED-FINGERPRINT：同一组红 + 没有写文件", () => {
  it("连续 4 次同一组红 ⇒ 先 ask（只一次），不是完成", () => {
    const guard = new RedFingerprintGuard({ askAfter: 4, stopAfter: 12 });
    for (let i = 0; i < 3; i++) {
      expect(guard.note({ redFiles: red, mutationRevision: 0, ranTests: true }).action).toBe("none");
    }
    const ask = guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    expect(ask.action).toBe("ask");
    expect(ask.message).toContain("根因假设");
    expect(guard.note({ redFiles: red, mutationRevision: 0, ranTests: true }).action).toBe("none");
  });

  it("写文件会重置计数（同一组红也可以是因为真的在改）", () => {
    const guard = new RedFingerprintGuard({ askAfter: 2, stopAfter: 4 });
    guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    const before = guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    expect(before.action).toBe("ask");
    const afterWrite = guard.note({ redFiles: red, mutationRevision: 1, ranTests: true });
    expect(afterWrite.action).toBe("none");
    expect(afterWrite.streak).toBe(1);
  });

  it("测试变绿 / 没跑测试 ⇒ 重置；连续 12 次才 stop", () => {
    const guard = new RedFingerprintGuard({ askAfter: 2, stopAfter: 4 });
    guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    expect(guard.note({ redFiles: [], mutationRevision: 0, ranTests: true }).action).toBe("none");
    expect(guard.currentStreak).toBe(0);

    for (let i = 0; i < 3; i++) guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    const stop = guard.note({ redFiles: red, mutationRevision: 0, ranTests: true });
    expect(stop.action).toBe("stop");
    expect(stop.message).toContain("没有改过任何文件");
  });

  it("没跑测试不累计（只读探索不会被误判）", () => {
    const guard = new RedFingerprintGuard({ askAfter: 2, stopAfter: 4 });
    for (let i = 0; i < 10; i++) {
      expect(guard.note({ redFiles: red, mutationRevision: 0, ranTests: false }).action).toBe("none");
    }
    expect(guard.currentStreak).toBe(0);
  });
});
