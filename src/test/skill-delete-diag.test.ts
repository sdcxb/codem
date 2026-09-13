/**
 * 技能删除诊断轨迹 —— 行为契约（第 72 波）
 *
 * 这些用例守的是"取证能力"本身：
 * 1. 轨迹必须**落盘**（不能只写控制台 —— 用户报的场景里窗口冻结、控制台什么都没有）；
 * 2. 轨迹写入**永远不能影响功能**（写盘失败必须被吞掉）；
 * 3. 心跳能把"主线程被卡住"变成可读数（drift 远大于间隔 → suspicion）；
 * 4. 渲染风暴检测每个窗口只报一次（否则它自己就成了噪声源）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppDataDir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  getAppDataDir: mocks.getAppDataDir,
  writeFile: mocks.writeFile,
  appendFile: mocks.appendFile,
}));

import { diagTrail, resetDiagState, startHeartbeat, noteRenderBurst } from "../core/skill/skill-delete-diag";

/** 等待诊断的 fire-and-forget 写盘落地（只依赖微任务，这样假定时器下也能用） */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("技能删除诊断轨迹", () => {
  beforeEach(() => {
    resetDiagState();
    mocks.getAppDataDir.mockReset().mockResolvedValue("C:\\Users\\x\\AppData\\Roaming\\com.codem.app\\");
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    mocks.appendFile.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("DIAG-1: 首条事件建文件（带会话头），后续事件追加", async () => {
    diagTrail("delete button clicked", { name: "vllm" });
    await flush();
    diagTrail("confirm action fired", { targetName: "vllm" });
    await flush();

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [path, firstContent] = mocks.writeFile.mock.calls[0];
    expect(path).toBe("C:\\Users\\x\\AppData\\Roaming\\com.codem.app\\.codem\\skills-delete-diag.log");
    expect(firstContent).toContain("session start");
    expect(firstContent).toContain("delete button clicked");
    expect(firstContent).toContain("vllm");

    expect(mocks.appendFile).toHaveBeenCalledTimes(1);
    expect(mocks.appendFile.mock.calls[0][1]).toContain("confirm action fired");
  });

  it("DIAG-2: 写盘失败绝不影响调用方（诊断只是旁路）", async () => {
    mocks.getAppDataDir.mockRejectedValue(new Error("no tauri"));
    expect(() => diagTrail("delete button clicked")).not.toThrow();
    await flush();

    resetDiagState();
    mocks.getAppDataDir.mockResolvedValue("C:\\x\\");
    mocks.writeFile.mockRejectedValue(new Error("disk full"));
    expect(() => diagTrail("confirm action fired")).not.toThrow();
    await flush();
  });

  it("DIAG-3: 心跳把主线程卡顿变成可读数（drift 超阈值 → suspicion）", async () => {
    vi.useFakeTimers();
    const stop = startHeartbeat("skill-manager", 2000);

    await vi.advanceTimersByTimeAsync(2000); // 正常一跳，drift≈0
    await flush();
    const normal = mocks.writeFile.mock.calls[0][1] + (mocks.appendFile.mock.calls[0]?.[1] ?? "");
    expect(normal).toContain("heartbeat");
    expect(normal).not.toContain("main-thread block");

    // 模拟主线程被同步工作占住 9 秒：时间跳过，但定时器只补跳一次
    vi.setSystemTime(Date.now() + 9000);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const appended = mocks.appendFile.mock.calls.map((c) => c[1]).join("");
    expect(appended).toContain("main-thread block");

    stop();
    const callsAfterStop = mocks.appendFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(mocks.appendFile.mock.calls.length).toBe(callsAfterStop);
  });

  it("DIAG-4: 渲染风暴每个窗口只报一次，且未超阈值不报", async () => {
    expect(noteRenderBurst(30, 1000)).toBe(false);
    await flush();
    expect(mocks.writeFile).not.toHaveBeenCalled();

    expect(noteRenderBurst(200, 1000)).toBe(true);
    await flush();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][1]).toContain("render burst");
    // 调用方用 reported 标志保证每窗口一次；阈值判断本身不受影响
    expect(noteRenderBurst(500, 1000)).toBe(true);
  });
});
