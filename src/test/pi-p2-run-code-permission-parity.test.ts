/**
 * Pi P2：`run_code` 的嵌套调用必须面对与直接调用**同一道闸门**。
 *
 * ## 缺陷（修复前）
 *
 * `createRunCodeTool().execute()` 构造的 `ToolSDK` 直接打文件 API：
 *   · `sdk.bash`  → `executeCommand(...)`              —— 从不经过 `analyzeBashCommand`
 *   · `sdk.write` → `writeFile(path, content, {workspace})` —— 从不经过 write 工具的覆盖确认
 * 而 `run_code` 自身在 `isAutoApprovable`（`security-mode.ts:149-184`）里恒为可自动放行
 * （特判被 `if (tool === "bash" && resource)` 挡住，末尾 `return true`）。
 * 结果：把 `Remove-Item -Recurse -Force ...` 包进 `run_code` 就绕过了危险命令闸门。
 *
 * ## 这一层为什么必须走真实 execute()
 *
 * 断言必须落在 (a) `execute()` 的返回值，以及 (b) **副作用有没有发生**
 * （`executeCommand` / `writeFile` 有没有被调用、磁盘有没有变）。
 * 只断言「源码里有 analyzeBashCommand」的话，把调用点删掉测试照样绿 ——
 * 本仓已经吃过「断言写在字符串上」的亏。
 *
 * ## 桩怎么接
 *
 * `run-code.ts` 对 `../../file-api` 用的是**动态 import**；`vi.mock` 对动态 import
 * 同样生效（`hook-fail-closed.test.ts` 已在用这一手法）。这里把整个 file-api
 * 换成可记录的假实现，其余命令一律抛错 —— 静默 `undefined` 会让「桩没接对」
 * 看起来像「功能正常」。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext, WriteConfirmResult, ToolExecuteResult } from "../core/llm/tools";
import { analyzeBashCommand } from "../core/permission/bash-analyzer";

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mocks.executeCommand,
  writeFile: mocks.writeFile,
  readFile: mocks.readFile,
  globSearch: mocks.globSearch,
  grepSearch: mocks.grepSearch,
}));

import { createRunCodeTool, execRunCode, calculateContentSimilarity } from "../core/llm/tools/run-code";

// ========== 夹具 ==========

let dir: string;

const EXISTING = "alpha = 1;\nbeta = 2;\ngamma = 3;\n";
/** 与 EXISTING 没有任何一行重合 —— 逐行相似度 0，远低于阈值 0.1 */
const UNRELATED = "完全无关的新内容，与旧内容没有任何一行重合\n";

/** 只读、无重定向、无替换 —— 必须被判成 readonly（反向对照用） */
const SAFE_COMMAND = "Get-ChildItem -Force";
/** PowerShell 递归强制删除，`POWERSHELL_DANGEROUS_PATTERNS` 第一条命中 */
const DANGEROUS_COMMAND = "Remove-Item -Recurse -Force C:\\important";

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd: dir,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ...over,
  } as ToolContext;
}

/** 把脚本里的 `sdk.bash("...")` 写成单引号字面量：TS 单引号串里不需要转义反斜杠 */
function bashCode(command: string): string {
  return `await sdk.bash('${command.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`;
}

async function run(code: string, ctx: ToolContext): Promise<ToolExecuteResult> {
  return await createRunCodeTool().execute({ code }, ctx);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codem-pi-p2-"));
  mocks.executeCommand.mockReset();
  mocks.writeFile.mockReset();
  mocks.readFile.mockReset();
  mocks.globSearch.mockReset();
  mocks.grepSearch.mockReset();

  mocks.executeCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.globSearch.mockResolvedValue([]);
  mocks.grepSearch.mockResolvedValue([]);
});

// ========== 用例 ==========

describe("P2-1: run_code 内的危险 bash 命令必须被拒绝执行", () => {
  it("前置条件：这条命令确实被分析器判为 dangerous（否则本用例证明不了任何事）", () => {
    const analysis = analyzeBashCommand(DANGEROUS_COMMAND);
    expect(
      analysis.classification,
      `夹具失效：analyzeBashCommand 没有把 ${DANGEROUS_COMMAND} 判为 dangerous —— ` +
        `那么「拒绝」与否都看不出来。patterns=${JSON.stringify(analysis.dangerousPatterns)}`,
    ).toBe("dangerous");
    expect(analysis.dangerousPatterns.length).toBeGreaterThan(0);
  });

  it("危险命令 → executeCommand 一次都没被调用，且输出里点名了命中的模式", async () => {
    const result = await run(bashCode(DANGEROUS_COMMAND), makeCtx({ securityMode: "auto" }));

    expect(
      mocks.executeCommand,
      "包装在 run_code 里的危险命令绝不能被真的执行",
    ).not.toHaveBeenCalled();
    expect(result.output).toContain("refused");
    // 报明「为什么拒绝」：命中的危险模式必须出现在给模型看的文本里
    expect(result.output).toContain("Remove-Item");
  });

  it("反向对照：只读命令仍然真的执行（修复不能是「一律拒绝」）", async () => {
    const analysis = analyzeBashCommand(SAFE_COMMAND);
    expect(analysis.classification, "夹具失效：安全命令竟被判为 dangerous").not.toBe("dangerous");

    const result = await run(`const r = ${bashCode(SAFE_COMMAND)}; console.log(r.stdout);`, makeCtx({ securityMode: "auto" }));

    expect(mocks.executeCommand, "安全命令必须照常执行").toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand.mock.calls[0][0]).toBe(SAFE_COMMAND);
    expect(result.output, "命令真实跑过时，它的 stdout 必须回到模型手里").toContain("ok");
  });

  it("fail-closed：分析器与 evaluateWithBashAnalysis 一致（dangerous 会被升为 ask）", async () => {
    // 与 bash-analyzer 的既有语义对齐：dangerous 至少是「需要人工批准」，
    // 而 run_code 内没有审批通道 ⇒ 拒绝是唯一不放行的选择。
    const { evaluateWithBashAnalysis } = await import("../core/permission/bash-analyzer");
    const settlement = evaluateWithBashAnalysis(DANGEROUS_COMMAND, "allow");
    expect(settlement.action).toBe("ask");
    expect(settlement.reason).toContain("dangerous");
  });

  it("同一道闸门也装在 execRunCode 上（provider 路径不能漏）", async () => {
    const result = await execRunCode(bashCode(DANGEROUS_COMMAND), { cwd: dir });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(result.error ?? "").toContain("refused");
  });

  it("fail-closed：分析器抛错时同样不执行（拿不准 ≠ 安全）", async () => {
    // 与 security-mode.ts:159-163 的 `catch { return false }` 同一约定。
    const analyzer = await import("../core/permission/bash-analyzer");
    const spy = vi.spyOn(analyzer, "analyzeBashCommand").mockImplementation(() => {
      throw new Error("simulated analyzer failure");
    });
    try {
      const result = await run(bashCode(SAFE_COMMAND), makeCtx({ securityMode: "auto" }));
      expect(spy, "前置条件：分析器确实被调用过").toHaveBeenCalled();
      expect(mocks.executeCommand, "分析器抛错不得导致命令被放行").not.toHaveBeenCalled();
      expect(result.output).toContain("refused");
      expect(result.output).toContain("fail-closed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("P2-2: run_code 内的覆盖写必须走与 write 工具相同的确认路径", () => {
  it("夹具：本地相似度实现与 write 工具的判据一致（0.1 阈值以下才需要确认）", () => {
    // 同一对内容若交给 write 工具（securityMode=ask + onWriteConfirm），
    // 它也会走到确认分支 —— 也就是下面那些用例的判据与 write 工具是同一档。
    expect(calculateContentSimilarity(EXISTING, EXISTING)).toBe(1);
    expect(calculateContentSimilarity(EXISTING, UNRELATED)).toBeLessThan(0.1);
  });

  it("securityMode=ask + 用户 reject → 一个字节都不写，且结果说明是被用户拒绝的", async () => {
    const file = join(dir, "target.txt");
    writeFileSync(file, EXISTING, "utf8");
    const before = readFileSync(file, "utf8");

    let confirmCalls = 0;
    const ctx = makeCtx({
      securityMode: "ask",
      onWriteConfirm: async (): Promise<WriteConfirmResult> => {
        confirmCalls++;
        return { action: "reject" };
      },
    });
    mocks.readFile.mockResolvedValue(EXISTING);

    const result = await run(`await sdk.write('${file.replace(/\\/g, "\\\\")}', ${JSON.stringify(UNRELATED)})`, ctx);

    expect(confirmCalls, "覆盖确认必须被真正走到（否则本用例只是「没触发确认」）").toBe(1);
    expect(mocks.writeFile, "用户拒绝后不得写盘").not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(result.output).toContain("rejected");
  });

  it("securityMode=ask + 用户 accept → 真的写盘（证明 reject 那侧不是「write 坏了」）", async () => {
    const file = join(dir, "accepted.txt");
    writeFileSync(file, EXISTING, "utf8");

    let confirmCalls = 0;
    const ctx = makeCtx({
      securityMode: "ask",
      onWriteConfirm: async (): Promise<WriteConfirmResult> => {
        confirmCalls++;
        return { action: "accept" };
      },
    });
    mocks.readFile.mockResolvedValue(EXISTING);

    await run(`await sdk.write('${file.replace(/\\/g, "\\\\")}', ${JSON.stringify(UNRELATED)})`, ctx);

    expect(confirmCalls).toBe(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const passed = mocks.writeFile.mock.calls[0];
    expect(passed[0]).toBe(file);
    expect(passed[1]).toBe(UNRELATED);
    // 原有的 workspace 沙箱参数必须保留（S5 检查在 file-api 内）
    expect(passed[2]).toEqual({ workspace: dir });
  });

  it("新建文件（读不到）不需要确认 —— 与 write 工具一致", async () => {
    const file = join(dir, "brand-new.txt");
    let confirmCalls = 0;
    const ctx = makeCtx({
      securityMode: "ask",
      onWriteConfirm: async (): Promise<WriteConfirmResult> => {
        confirmCalls++;
        return { action: "reject" };
      },
    });
    mocks.readFile.mockRejectedValue(new Error("ENOENT"));

    await run(`await sdk.write('${file.replace(/\\/g, "\\\\")}', ${JSON.stringify(UNRELATED)})`, ctx);

    expect(confirmCalls, "新建文件没有可覆盖的内容，不该弹确认").toBe(0);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false); // writeFile 是桩，没有真写盘
  });
});

describe("P2-3: 工具不得再声称自己是沙箱", () => {
  it("guidance / description 里没有 sandbox / isolated / 沙箱 / 隔离", () => {
    const tool = createRunCodeTool();
    // 反向对照：字段本身必须存在且有内容（否则 toContain 之类的断言会「因为空」而绿）
    expect(typeof tool.guidance).toBe("string");
    expect((tool.guidance || "").length).toBeGreaterThan(20);
    expect(tool.description.length).toBeGreaterThan(50);

    for (const text of [tool.guidance || "", tool.description]) {
      expect(text, "不得声称沙箱/隔离").not.toMatch(/sandbox|isolated|隔离|沙箱/i);
    }
    // 必须明说它用应用自身权限在进程内跑，且嵌套调用受权限检查
    const all = `${tool.guidance} ${tool.description}`.toLowerCase();
    expect(all).toContain("in-process");
    expect(all).toMatch(/permission-checked|permission checks/);
  });
});
