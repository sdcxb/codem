/**
 * 控制台噪声契约（第 58 波）。
 *
 * 用户报的现场：一次 `write` 工具调用在控制台打出两遍
 *   `[AgenticLoop] Service "snapshot" not available, falling back to singleton`（带调用栈），
 * 外加十余条"每轮迭代 / 每条消息 / 每次请求"的 `console.log`（其中一条会把工具参数 ——
 * 含生成的文件内容 —— 打进控制台）。于是本案锁三件事：
 *   ① 快照服务是按 cwd 单例的，**不该走 ctx.get('snapshot')**（没有任何 Provider 注册这个名字）；
 *   ② 容错回退告警**只报一次**（回退是设计好的容错，但"服务没接上"值得知道一次）；
 *   ③ 热路径诊断日志**默认静默**，需要时用 `codem-debug` 开关打开。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { debugLog, isDebugEnabled, warnOnce, resetWarnOnce, resetDebugCache } from "../core/debug";

const ROOT = join(__dirname, "..", "..");
/** 读源码（相对 src/） */
const read = (p: string) => readFileSync(join(ROOT, "src", p), "utf8");

function makeLoop(ctx: any = null) {
  const provider = { id: "test", stream: async function* () {}, complete: async () => "" } as any;
  const loop = new AgenticLoop(provider, new Map() as any, {} as any);
  if (ctx) (loop as any).setContext(ctx);
  return loop as any;
}

describe("控制台噪声契约（第 58 波）", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWarnOnce();
    resetDebugCache();
    try { (globalThis as any).localStorage?.removeItem?.("codem-debug"); } catch { /* noop */ }
    delete (globalThis as any).__CODEM_DEBUG__;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    resetWarnOnce();
    resetDebugCache();
  });

  it("LOG-1: 容错回退告警每个服务只报一次（不再每次工具调用都刷屏）", () => {
    const ctx = { get: () => undefined }; // 所有服务都取不到 → 全部走回退
    const loop = makeLoop(ctx);
    for (let i = 0; i < 5; i++) {
      loop.getTelemetry();
      loop.getEventLog();
      loop.getPermissionManager();
    }
    const warnCalls = warnSpy.mock.calls.filter((c) => String(c[0]).includes("falling back to singleton"));
    expect(warnCalls.length, `应只报一次，实际 ${warnCalls.length} 次`).toBe(3); // 3 个不同的服务各一次
    // 再调一次也不会新增
    loop.getTelemetry();
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('Service "telemetry"')).length).toBe(1);
  });

  it("LOG-2: 快照服务不再走 ctx.get('snapshot')，也不产生任何告警", () => {
    const requested: string[] = [];
    const ctx = { get: (name: string) => { requested.push(name); return undefined; } };
    const loop = makeLoop(ctx);
    const svc = loop.getSnapshotService("D:\\tmp\\proj");
    expect(svc, "应返回按 cwd 单例的快照服务").toBeTruthy();
    expect(typeof svc.create).toBe("function");
    expect(requested, "不应再向 ctx 索取 'snapshot'（没有任何 Provider 注册它）").not.toContain("snapshot");
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("snapshot")).length).toBe(0);
    // 同一 cwd 拿到的是同一个实例（按 cwd 单例语义）
    expect(loop.getSnapshotService("D:\\tmp\\proj")).toBe(svc);
  });

  it("LOG-3: 热路径诊断日志默认静默，开启 codem-debug 后才输出", () => {
    expect(isDebugEnabled("agent-loop")).toBe(false);
    debugLog("agent-loop", "这条不该出现");
    expect(logSpy.mock.calls.filter((c) => String(c[1] ?? c[0]).includes("这条不该出现")).length).toBe(0);

    (globalThis as any).__CODEM_DEBUG__ = "agent-loop";
    resetDebugCache();
    expect(isDebugEnabled("agent-loop")).toBe(true);
    expect(isDebugEnabled("provider"), "未开启的命名空间仍应静默").toBe(false);
    debugLog("agent-loop", "这条应该出现");
    expect(logSpy.mock.calls.some((c) => c.some((a) => String(a).includes("这条应该出现")))).toBe(true);
  });

  it("LOG-4: 源码层面——迭代/请求级别的诊断日志必须走 debugLog（不得回到裸 console.log）", () => {
    const loop = read("core/llm/agentic-loop.ts");
    // 这些曾经每次迭代/每条消息就打印的文案，现在必须包在 debugLog 里
    for (const marker of [
      "`[AgenticLoop] Iteration ${this.state.iteration}: calling LLM",
      "`[AgenticLoop] Iteration ${this.state.iteration}: LLM stream ended",
      "`[AgenticLoop] Iteration ${this.state.iteration} completed",
      "`[buildMessages] raw:",
      "collaborationMode=${this.config.collaborationMode}",
    ]) {
      expect(loop, `${marker} 不应再以裸 console.log 出现`).not.toMatch(new RegExp(`console\\.log\\(${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    expect(loop).toContain("debugLog(\"agent-loop\"");
    // 回退告警必须走 warnOnce（而不是每次都 warn）
    expect(loop).toMatch(/warnOnce\('svc:/);
    expect(loop, "不应再有逐次调用的裸 console.warn(...falling back...)").not.toMatch(/console\.warn\('\[AgenticLoop\] Service/);

    const provider = read("core/llm/provider.ts");
    expect(provider).not.toMatch(/console\.log\("\[Provider\] Tool call end:"/);
    expect(provider).toContain('debugLog("provider", "Tool call end:"');

    const app = read("App.tsx");
    expect(app).not.toMatch(/console\.log\(`\[AutoSave\] Debounce save/);
    expect(app).toContain('debugLog("autosave"');
  });

  it("LOG-5: 关键告警没有被误静默（错误仍是 console.error，回退仍有提示）", () => {
    const loop = read("core/llm/agentic-loop.ts");
    // LLM 流错误等必须保留 error 级别
    expect(loop).toMatch(/console\.error\(`\[AgenticLoop\] Iteration \$\{this\.state\.iteration\}: LLM stream error/);
    // EXT-048 依赖的文案仍在（回退到单例）
    expect(loop).toContain("falling back to singleton");
  });
});
