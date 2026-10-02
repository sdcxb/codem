/**
 * 第 D10b 波（假成功 A 类）：把同一类缺陷在 `dynamic-plugin-tools.ts` /
 * `tools/read-attachment.ts` / `tools/zvec-tool.ts` 里清干净。
 *
 * ## 这一批的共同形状
 *
 * 工具确实失败了（操作抛错 / 协作者返回 `success:false` / MCP 自报 `isError`），
 * 但失败文本的首行**不以** `Error:` / `错误：` / `失败：` 开头，也没有显式 `isError`：
 *
 * | 位置 | 失败文本首行 | 为什么文本启发式接不住 |
 * | --- | --- | --- |
 * | `dynamic-plugin-tools.ts` | `Failed to define plugin: …` | 前缀是 `Failed`，不在正则里 |
 * | `tools/read-attachment.ts` | `Failed to resolve workspace path…` | 同上；而且它在 `CONTENT_TOOLS` 里，启发式**按设计关闭**，只有 `isError` 能表达失败 |
 * | `tools/zvec-tool.ts` | `[zvec-grep error]…` | 首字符是 `[`，永远匹配不上 |
 *
 * 于是 `classifyToolResult` 判成 `completed`：界面绿、`session/ui-handoff.ts` 当成产物、
 * 委派汇报说做完了。修法统一为**显式 `isError: true`**（与 D8/D9/D10 一致）——
 * 这一类的要点就是「文本不是契约」。
 *
 * ## 每条修复都配了「反向对照」，而且断言协作者**确实被调用过**
 *
 * 本项目栽过「输入本来就不合法，于是删掉检查也照样红/绿」的坑。所以每个失败分支都配一条
 * **同样调用形状、只把协作者返回值换成成功** 的用例，并断言协作者被调用 ——
 * 证明测试真的走到了那条分支，而不是在别处提前返回。
 *
 * ## 也守住了「没有结果」不是「失败」
 *
 * `read_attachment` 无附件时列空、`zvec` 检索零命中，都必须仍然是 `completed`
 * （对标本仓第 47 轮补的原则：读不到 ≠ 你没有数据；反过来，没有数据 ≠ 出错）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ========== Mock：file-api（只替换被测路径用到的四个；其余透传真实实现） ==========
const { mockGetDefaultCwd, mockReadFileLines, mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockGetDefaultCwd: vi.fn(),
  mockReadFileLines: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("../core/file-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/file-api")>();
  return {
    ...actual,
    getDefaultCwd: (...args: unknown[]) => mockGetDefaultCwd(...args),
    readFileLines: (...args: unknown[]) => mockReadFileLines(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  };
});

// ========== Mock：两个 store（附件来源） ==========
const { mockAppStoreGetState, mockProjectStoreGetState } = vi.hoisted(() => ({
  mockAppStoreGetState: vi.fn(),
  mockProjectStoreGetState: vi.fn(),
}));

vi.mock("../store", () => ({
  useAppStore: { getState: () => mockAppStoreGetState() },
}));

vi.mock("../core/store", () => ({
  useProjectStore: { getState: () => mockProjectStoreGetState() },
}));

// ========== Mock：附件持久层（只测"内存里没有内容 → 走磁盘"这条路） ==========
vi.mock("../core/storage/message", () => ({
  listAllAttachments: () => [],
  listMessages: () => [],
  getAttachmentContent: () => null,
}));

import { ToolRegistry, setToolContext, type ToolContext } from "../core/llm/tools";
import {
  createCordisDefineTool,
  createCordisRunTool,
  createCordisStopTool,
  createCordisUndefineTool,
} from "../core/llm/dynamic-plugin-tools";
import { createReadAttachmentTool } from "../core/llm/tools/read-attachment";
import { createZvecTool, ZVEC_MCP_SERVER_NAME } from "../core/llm/tools/zvec-tool";
import { getMCPRegistry } from "../core/mcp/mcp";

function makeCtx(): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd: "/fake/ws",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  };
}

function runTool(toolId: string, tool: Parameters<ToolRegistry["register"]>[0], args: Record<string, unknown>) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return registry.execute("tc-1", toolId, args, makeCtx());
}

beforeEach(() => {
  mockGetDefaultCwd.mockReset();
  mockReadFileLines.mockReset();
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  mockAppStoreGetState.mockReset();
  mockProjectStoreGetState.mockReset();
  mockAppStoreGetState.mockReturnValue({ messages: [] });
  mockProjectStoreGetState.mockReturnValue({ currentSession: null });
});

afterEach(() => {
  setToolContext(null as unknown as Parameters<typeof setToolContext>[0]);
  vi.restoreAllMocks();
});

// =====================================================================
// 1. dynamic-plugin-tools.ts —— runner 返回 success:false
// =====================================================================

interface FakeRunner {
  define: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  retract: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

/** 协作者替身：默认全部成功；用例按需把某一条改成失败 */
function installRunner(overrides: Partial<FakeRunner> = {}): FakeRunner {
  const runner: FakeRunner = {
    define: vi.fn(async () => ({ success: true })),
    run: vi.fn(async () => ({ success: true, result: { ok: 1 } })),
    retract: vi.fn(() => ({ success: true })),
    inspect: vi.fn(() => ({ plugins: [], services: [] })),
    ...overrides,
  };
  setToolContext({
    get: (name: string) => (name === "dynamicCordisRunner" ? runner : undefined),
  } as unknown as Parameters<typeof setToolContext>[0]);
  return runner;
}

const FAIL = { success: false, error: "boom: compile error" };

describe("D10b: cordis_* 动态插件工具 —— runner 报失败时必须判 error", () => {
  it("D10b-1: cordis_define 定义失败 → error（且确实调用了 runner.define）", async () => {
    const runner = installRunner({ define: vi.fn(async () => FAIL) });

    const res = await runTool("cordis_define", createCordisDefineTool(), {
      name: "my-plugin",
      code: "module.exports = () => {}",
    });

    // 反向对照的前提：确实走到了 runner（不是「参数不合法所以提前返回」）
    expect(runner.define).toHaveBeenCalledTimes(1);
    expect(runner.define).toHaveBeenCalledWith("my-plugin", "module.exports = () => {}");
    expect(res.status).toBe("error");
    expect(res.error, "error 字段必须给出原因").toBeTruthy();
    expect(res.output).toContain("Failed to define plugin");
  });

  it("D10b-1c: 反向对照 —— 同一个 runner 成功时是 completed（证明上面那条不是恒真）", async () => {
    const runner = installRunner();
    const res = await runTool("cordis_define", createCordisDefineTool(), {
      name: "my-plugin",
      code: "module.exports = () => {}",
    });

    expect(runner.define).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("completed");
    expect(res.error).toBeUndefined();
    expect(res.output).toContain("defined successfully");
  });

  it("D10b-2: cordis_run 运行失败 → error（成功时 completed）", async () => {
    const runner = installRunner({ run: vi.fn(async () => FAIL) });
    const res = await runTool("cordis_run", createCordisRunTool(), { name: "my-plugin" });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output).toContain("Failed to run plugin");

    const okRunner = installRunner();
    const ok = await runTool("cordis_run", createCordisRunTool(), { name: "my-plugin" });
    expect(okRunner.run).toHaveBeenCalledTimes(1);
    expect(ok.status).toBe("completed");
  });

  it("D10b-3: cordis_stop 停止失败 → error（dispose 没跑，插件仍在运行）", async () => {
    const runner = installRunner({ retract: vi.fn(() => FAIL) });
    const res = await runTool("cordis_stop", createCordisStopTool(), { name: "my-plugin" });
    expect(runner.retract, "确实调用了 retract（失败来自它返回 success:false）").toHaveBeenCalledTimes(1);
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output).toContain("Failed to stop plugin");

    const okRunner = installRunner();
    const ok = await runTool("cordis_stop", createCordisStopTool(), { name: "my-plugin" });
    expect(okRunner.retract).toHaveBeenCalledTimes(1);
    expect(ok.status).toBe("completed");
  });

  it("D10b-4: cordis_undefine 移除失败 → error（destructive 契约下最贵的一种假成功）", async () => {
    const runner = installRunner({ retract: vi.fn(() => FAIL) });
    const res = await runTool("cordis_undefine", createCordisUndefineTool(), { name: "my-plugin" });
    expect(runner.retract).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output).toContain("Failed to undefine plugin");

    const okRunner = installRunner();
    const ok = await runTool("cordis_undefine", createCordisUndefineTool(), { name: "my-plugin" });
    expect(okRunner.retract).toHaveBeenCalledTimes(1);
    expect(ok.status).toBe("completed");
  });
});

// =====================================================================
// 2. tools/read-attachment.ts —— 磁盘读取路径抛错
// =====================================================================

/** 内存里没有内容、但有 sandboxPath 的附件：会走到「磁盘按行读取」那条路 */
function diskBackedAttachment() {
  return {
    id: "att-disk-1",
    name: "big.txt",
    type: "file",
    content: "",
    size: 12345,
    sandboxPath: ".attachments/att-disk-1-big.txt",
  };
}

describe("D10b: read_attachment 读磁盘失败 —— CONTENT_TOOLS 豁免下只有 isError 能表达失败", () => {
  it("D10b-5: getDefaultCwd 抛错 → error（确实调用了 getDefaultCwd）", async () => {
    mockAppStoreGetState.mockReturnValue({ messages: [{ id: "m1", attachments: [diskBackedAttachment()] }] });
    mockGetDefaultCwd.mockRejectedValue(new Error("engine not ready"));

    const res = await runTool("read_attachment", createReadAttachmentTool(), { attachment_id: "att-disk-1" });

    expect(mockGetDefaultCwd, "确实走到了路径解析那条分支").toHaveBeenCalledTimes(1);
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output).toContain("Failed to resolve workspace path");
  });

  it("D10b-6: readFileLines 抛错 → error（确实按解析出的路径读了磁盘）", async () => {
    mockAppStoreGetState.mockReturnValue({ messages: [{ id: "m1", attachments: [diskBackedAttachment()] }] });
    mockGetDefaultCwd.mockResolvedValue("C:/ws");
    mockReadFileLines.mockRejectedValue(new Error("EACCES: permission denied"));

    const res = await runTool("read_attachment", createReadAttachmentTool(), { attachment_id: "att-disk-1" });

    expect(mockReadFileLines, "确实调用了磁盘读取").toHaveBeenCalledTimes(1);
    expect(String(mockReadFileLines.mock.calls[0][0])).toContain("att-disk-1-big.txt");
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output).toContain("Failed to read file");
  });

  it("D10b-7: 反向对照 —— 同一份附件、同一调用形状，磁盘读成功后是 completed 且内容真的回来了", async () => {
    mockAppStoreGetState.mockReturnValue({ messages: [{ id: "m1", attachments: [diskBackedAttachment()] }] });
    mockGetDefaultCwd.mockResolvedValue("C:/ws");
    mockReadFileLines.mockResolvedValue({ text: "content from disk", totalLines: 1, hasMore: false });

    const res = await runTool("read_attachment", createReadAttachmentTool(), { attachment_id: "att-disk-1" });

    expect(mockReadFileLines).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("completed");
    expect(res.error).toBeUndefined();
    expect(res.output).toContain("content from disk");
  });

  it("D10b-8: 没有附件时的「列空」仍是 completed —— 不把『没有结果』变成错误", async () => {
    mockAppStoreGetState.mockReturnValue({ messages: [] });

    const res = await runTool("read_attachment", createReadAttachmentTool(), {});

    expect(res.status).toBe("completed");
    expect(res.output).toContain("No attachments found");
  });
});

// =====================================================================
// 3. tools/zvec-tool.ts —— MCP 自报 isError / 调用抛错
// =====================================================================

function zvecToolDef() {
  return createZvecTool({
    name: "zvec_grep_search",
    server: ZVEC_MCP_SERVER_NAME,
    description: "semantic search",
    inputSchema: {},
  } as never);
}

describe("D10b: zvec 工具 —— MCP 自报失败时必须判 error（零命中仍是成功）", () => {
  it("D10b-9: MCP 返回 isError:true → error，且诊断文本原样保留", async () => {
    const spy = vi
      .spyOn(getMCPRegistry(), "callTool")
      .mockResolvedValue({ content: [{ type: "text", text: "index not ready" }], isError: true } as never);

    const res = await runTool("zvec_grep_search", zvecToolDef(), { query: "foo" });

    expect(spy, "确实调用了 MCP").toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(ZVEC_MCP_SERVER_NAME);
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output, "失败文本照旧给模型看（它不是契约，但有用）").toContain("[zvec-grep error]");
    expect(res.output).toContain("index not ready");
  });

  it("D10b-10: MCP 调用抛错 → error（检索从未发生）", async () => {
    const spy = vi.spyOn(getMCPRegistry(), "callTool").mockRejectedValue(new Error("server disconnected"));

    const res = await runTool("zvec_grep_search", zvecToolDef(), { query: "foo" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
    expect(res.output).toContain("server disconnected");
  });

  it("D10b-11: 反向对照 —— 正常命中时是 completed 且证据文本原样返回", async () => {
    vi.spyOn(getMCPRegistry(), "callTool").mockResolvedValue({
      content: [{ type: "text", text: "src/a.ts:10: hit" }],
    } as never);

    const res = await runTool("zvec_grep_search", zvecToolDef(), { query: "foo" });

    expect(res.status).toBe("completed");
    expect(res.error).toBeUndefined();
    expect(res.output).toBe("src/a.ts:10: hit");
  });

  it("D10b-12: 检索成功但零命中仍是 completed —— 不把『没有结果』变成错误", async () => {
    vi.spyOn(getMCPRegistry(), "callTool").mockResolvedValue({ content: [] } as never);

    const res = await runTool("zvec_grep_search", zvecToolDef(), { query: "no-such-symbol" });

    expect(res.status).toBe("completed");
    expect(res.error).toBeUndefined();
    expect(res.output).not.toContain("[zvec-grep error]");
  });
});
