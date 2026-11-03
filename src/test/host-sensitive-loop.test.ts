/**
 * 共享工作区的两个**循环级**配套判据（CACHE-H1 / SNAP-H1）。
 *
 * 为什么必须在这里测（而不是只测纯函数）：
 * - 读缓存是 `AgenticLoop` 内部的优化，敏感路径若命中缓存，第二次读取**不会执行工具**，
 *   也就不会再弹审批 —— "每次读取都要批准"会变成假话；
 * - 快照在工具执行**之前**读目标文件，而 Host 的写审批在工具内部 ⇒ 共享工作区必须关掉它，
 *   否则快照会成为敏感读取审批的旁路（模型请求写 `.env`，用户即使拒绝，内容也已进快照）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { ToolRegistry } from "../core/llm/tools";
import { SnapshotService } from "../core/snapshot/snapshot";
import * as fileApi from "../core/file-api";
import { ScriptedProvider } from "./helpers/scripted-provider";

const SESSION = "test-sensitive-loop";
const dirs: string[] = [];

function readIteration(id: string, path: string): any[] {
  const input = { path };
  return [
    { type: "tool_use_start", id, name: "read" },
    { type: "tool_use_delta", id, input: JSON.stringify(input) },
    { type: "tool_use_end", id, input },
    { type: "end", finishReason: "tool_use" },
  ];
}

function writeIteration(id: string, path: string): any[] {
  const input = { path, content: "x" };
  return [
    { type: "tool_use_start", id, name: "write" },
    { type: "tool_use_delta", id, input: JSON.stringify(input) },
    { type: "tool_use_end", id, input },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

async function drain(loop: AgenticLoop, cwd: string): Promise<any[]> {
  const events: any[] = [];
  for await (const event of loop.run(SESSION, "读文件", cwd, "system prompt")) events.push(event);
  return events;
}

function countingRegistry(): { registry: ToolRegistry; calls: string[] } {
  const registry = new ToolRegistry();
  const calls: string[] = [];
  registry.register({
    id: "read",
    description: "假 read（判据夹具：统计真实执行次数）",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    contract: { readOnly: true, accessScope: "workspace" },
    async execute(args: any) {
      calls.push(String(args?.path ?? ""));
      return { title: `read ${String(args?.path ?? "")}`, output: `BODY-${calls.length}` };
    },
  } as any);
  registry.register({
    id: "write",
    description: "假 write（判据夹具：只用来触发 pre-call 快照）",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] },
    contract: { sideEffectScope: "workspace", accessScope: "workspace" },
    async execute(args: any) {
      return { title: `write ${String(args?.path ?? "")}`, output: `已写入 ${String(args?.path ?? "")}` };
    },
  } as any);
  return { registry, calls };
}

async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codem-loop-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("CACHE-H1 敏感路径不进 read 缓存", () => {
  it("同一路径读两次（同 offset/limit）⇒ 工具真的执行两次", async () => {
    const cwd = await tempCwd();
    const provider = new ScriptedProvider();
    provider.setScript([readIteration("r1", ".env"), readIteration("r2", ".env"), finalIteration("完成")]);
    const { registry, calls } = countingRegistry();
    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "m",
      securityMode: "full",
      bypassReadCacheFor: (path: string) => path === ".env",
    });
    await drain(loop, cwd);
    expect(calls, "敏感路径命中缓存就等于绕过了第二次审批").toEqual([".env", ".env"]);
  });

  it("反向对照：普通路径仍然吃缓存（只执行一次）", async () => {
    const cwd = await tempCwd();
    const provider = new ScriptedProvider();
    provider.setScript([readIteration("r1", "src/a.ts"), readIteration("r2", "src/a.ts"), finalIteration("完成")]);
    const { registry, calls } = countingRegistry();
    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "m",
      securityMode: "full",
      bypassReadCacheFor: (path: string) => path === ".env",
    });
    await drain(loop, cwd);
    expect(calls, "普通路径的读缓存优化必须保留").toEqual(["src/a.ts"]);
  });
});

describe("SNAP-H1 共享工作区可关闭自动快照", () => {
  it("enableSnapshots:false ⇒ 改动工具执行前不创建快照", async () => {
    const cwd = await tempCwd();
    const create = vi.spyOn(SnapshotService.prototype, "create").mockResolvedValue({ id: "snap-test" } as never);
    const provider = new ScriptedProvider();
    provider.setScript([
      writeIteration("w1", "a.txt"),
      finalIteration("完成"),
      finalIteration("完成（收尾）"),
    ]);
    const { registry } = countingRegistry();
    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "m",
      securityMode: "full",
      enableSnapshots: false,
    });
    await drain(loop, cwd);
    expect(create).not.toHaveBeenCalled();
  });

  it("默认（不传）⇒ 快照照旧创建（桌面行为不变）", async () => {
    const cwd = await tempCwd();
    /*
     * 夹具环境没有 Tauri，`file-api.exists` 会返回 false ⇒ 前置判定会当成"工作区不存在"跳过。
     * 这里显式让工作区存在，才能测到"默认仍然创建快照"这条真实分支。
     */
    vi.spyOn(fileApi, "exists").mockResolvedValue(true);
    const create = vi.spyOn(SnapshotService.prototype, "create").mockResolvedValue({ id: "snap-test" } as never);
    const provider = new ScriptedProvider();
    provider.setScript([
      writeIteration("w1", "a.txt"),
      finalIteration("完成"),
      finalIteration("完成（收尾）"),
    ]);
    const { registry } = countingRegistry();
    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "m",
      securityMode: "full",
    });
    await drain(loop, cwd);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
