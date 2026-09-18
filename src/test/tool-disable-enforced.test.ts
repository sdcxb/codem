/**
 * 「工具管理」的禁用开关必须**真的**生效（第 47 轮补，UI/UX 审计 P1）
 *
 * ## 守的缺陷
 *
 * 面板上写着"**禁用的工具不会出现在 LLM 的可用工具列表中**"，用户把 `bash`
 * 关掉、行变灰、重启后还是关的（设置确实落库了）——
 * 而 `codem-disabled-tools` 这个键**全仓没有任何读取方**：模型侧的工具集构建
 * 完全不过滤，`bash` 照样能被调用。
 *
 * 安全侧的开关说假话比没有开关更糟：用户会据此**放松警惕**。
 *
 * ## 两层都要守（缺一不可 —— 只做定义层的话"禁用"仍只是"看不见"，不是"调不到"）
 *
 * | 组 | 守什么 |
 * | --- | --- |
 * | `TOOLOFF-1` | **定义层**：禁用的工具不出现在 `getAll` / `getDefinitions` / `getCoreDefinitions` / `getDeferredDefinitions` |
 * | `TOOLOFF-2` | **执行层**：即使拿到 name 直接 `execute`，也必须被拒（返回 error，不是静默成功） |
 * | `TOOLOFF-3` | 子作用域（子智能体）**同样**受约束 —— 它注册的 overlay 工具也要过判据 |
 * | `TOOLOFF-4` | 开关切换后**当前进程立即生效**（缓存必须被失效） |
 * | `TOOLOFF-5` | 方向相反的对照：没被禁用的工具照常可用（不能把判据做成哑巴全拦） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

type Row = Record<string, unknown>;
let port: FakeStoragePort;

const settingRow = (key: string, value: unknown): Row => ({ key, value: JSON.stringify(value) });

async function installPort(disabled: string[] | null) {
  port = createFakeStoragePort({
    seed: disabled === null ? {} : { settings: [settingRow("codem-disabled-tools", disabled)] },
  });
  await port.config.warmup();
  setStoragePort(port);
  return port;
}

/** 造一个注册了两个工具的最小注册表 */
async function makeRegistry() {
  const mod = await import("../core/llm/tools");
  const { ToolRegistry } = mod as unknown as {
    ToolRegistry: new () => {
      register(t: unknown): void;
      getAll(): Array<{ id: string }>;
      get(id: string): unknown;
      getDefinitions(): Array<{ name: string }>;
      getCoreDefinitions(): Array<{ name: string }>;
      getDeferredDefinitions(): Array<{ name: string }>;
      createScope(): unknown;
      execute(id: string, name: string, args: unknown, ctx: unknown): Promise<{ status: string; error?: string }>;
    };
  };
  const reg = new ToolRegistry();
  reg.register({
    id: "bash",
    description: "执行命令",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: "ran" }),
  });
  reg.register({
    id: "read_file",
    description: "读文件",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: "content" }),
  });
  return { reg, mod };
}

beforeEach(async () => {
  setStoragePort(null);
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  // 每个用例都从"没有缓存"开始（模块级缓存会跨用例残留）
  const mod = await import("../core/llm/tools");
  (mod as unknown as { invalidateDisabledToolsCache: () => void }).invalidateDisabledToolsCache();
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("TOOLOFF：禁用开关真的生效（定义层 + 执行层）", () => {
  it("TOOLOFF-1: 禁用的工具不出现在任何一个给模型的定义列表里", async () => {
    await installPort(["bash"]);
    const { reg } = await makeRegistry();

    const all = reg.getAll().map((t) => t.id);
    expect(all, "bash 被禁用 → 不能出现在执行器里").not.toContain("bash");
    expect(all, "没禁用的照常在").toContain("read_file");

    expect(reg.getDefinitions().map((d) => d.name)).not.toContain("bash");
    expect(
      reg.getCoreDefinitions().map((d) => d.name),
      "非延迟定义（真正发给模型的那一份）也不能含它",
    ).not.toContain("bash");
    expect(reg.getDeferredDefinitions().map((d) => d.name)).not.toContain("bash");
  });

  it("TOOLOFF-2: 拿到 name 直接 execute 也必须被拒（不是静默成功）", async () => {
    await installPort(["bash"]);
    const { reg } = await makeRegistry();

    const r = await reg.execute("call-1", "bash", { command: "rm -rf /" }, {});

    expect(r.status, "必须是 error，不许静默成功").toBe("error");
    expect(String(r.error), "错误里要写清原因（模型与用户都能看到）").toContain("禁用");
  });

  it("TOOLOFF-3: 子作用域（子智能体）注册的同名工具也受约束", async () => {
    await installPort(["bash"]);
    const { reg } = await makeRegistry();
    const scope = reg.createScope() as {
      register(t: unknown): void;
      getAll(): Array<{ id: string }>;
      get(id: string): unknown;
      execute(id: string, name: string, args: unknown, ctx: unknown): Promise<{ status: string }>;
    };

    // 子作用域**自己**注册一个被禁用的同名工具（overlay）
    scope.register({
      id: "bash",
      description: "子作用域自己的 bash",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ output: "ran" }),
    });

    expect(
      scope.getAll().map((t) => t.id),
      "overlay 也必须过禁用判据 —— 否则子智能体绕过用户的开关",
    ).not.toContain("bash");
    expect(scope.get("bash"), "get 也要拦住（execute 走的是 get）").toBeUndefined();
    expect((await scope.execute("c", "bash", {}, {})).status).toBe("error");
  });

  it("TOOLOFF-4: 切换开关后当前进程立即生效（缓存被失效）", async () => {
    await installPort([]); // 什么都没禁用
    const { reg, mod } = await makeRegistry();
    expect(reg.getAll().map((t) => t.id), "前提：bash 可用").toContain("bash");

    // 用户把 bash 关掉（`ToolManager` 会写设置 + 让缓存失效）
    const { setSettingJSON } = await import("../core/storage/settings");
    setSettingJSON("codem-disabled-tools", ["bash"]);
    (mod as unknown as { invalidateDisabledToolsCache: () => void }).invalidateDisabledToolsCache();

    expect(
      reg.getAll().map((t) => t.id),
      "改前：缓存没失效 → 当前进程内仍然能调用它（安全开关形同虚设）",
    ).not.toContain("bash");
    expect((await reg.execute("c", "bash", {}, {})).status).toBe("error");
  });

  it("TOOLOFF-5: 没被禁用的工具照常可用（判据不许做成哑巴全拦）", async () => {
    await installPort(["bash"]);
    const { reg } = await makeRegistry();

    const r = await reg.execute("call-2", "read_file", {}, {});
    expect(r.status, "read_file 没被禁用 → 必须能正常执行").not.toBe("error");
  });

  it("TOOLOFF-6: 禁用列表读不到（没有这个键）→ 什么都不禁用，与旧行为一致", async () => {
    await installPort(null); // 库里没有这个键
    const { reg } = await makeRegistry();
    expect(
      reg.getAll().map((t) => t.id),
      "没有这个键 = 什么都没禁用（不能凭空禁用工具）",
    ).toEqual(expect.arrayContaining(["bash", "read_file"]));
  });
});
