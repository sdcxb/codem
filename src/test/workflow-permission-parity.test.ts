/**
 * `workflow` 工具：嵌套 `sdk.bash` / `sdk.write` 必须面对与直接调用**同一道闸门**。
 *
 * ## 缺陷（修复前）
 *
 * `workflow-engine.ts` 的 `WorkflowSDK` 直接打文件 API：
 *   · `sdk.bash`  → `executeCommand(command, ctx.cwd, 60_000)` —— 从不经过 `analyzeBashCommand`
 *   · `sdk.write` → `writeFile(path, content, { workspace })`  —— 从不经过受保护路径检查
 *     与 write 工具的覆盖确认
 * 而 `workflow` 在 `isAutoApprovable`（`security-mode.ts:149-184`）里恒为可自动放行
 * （特判被 `if (tool === "bash" && resource)` 挡住，末尾 `return true`）。
 * 结果：把 `Remove-Item -Recurse -Force ...` 包进 workflow 就绕过了危险命令闸门 ——
 * 与上一轮修掉的 `run_code` 是**同一个缺口**。
 *
 * ## 断言落在哪
 *
 * 只看源码会假绿（把调用点删掉，正则还在）。这里断言
 * (a) `execute()` 的返回值、(b) **副作用有没有发生**（file-api 的桩有没有被调用）。
 *
 * ## 桩怎么接
 *
 * `workflow-engine.ts` 对 `../file-api` 用动态 import；`vi.mock` 对动态 import
 * 同样生效（与 `pi-p2-run-code-permission-parity.test.ts` 同一手法）。
 *
 * ## 与 run_code 的关系
 *
 * 两边的闸门现在是 `src/core/llm/tool-gates.ts` 里的**同一份实现**。
 * 本文件是 workflow 侧的证据；run_code 侧的证据是 pi-p2 / pi-p2b（16 个用例，未修改）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext, WriteConfirmResult, ToolExecuteResult } from "../core/llm/tools";
import { analyzeBashCommand } from "../core/permission/bash-analyzer";
import { isShellLike, resolveToolContract } from "../core/llm/tool-contract";

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

import { createWorkflowTool, execWorkflow } from "../core/llm/workflow-engine";
import { installScriptRunnerDouble, uninstallScriptRunnerDouble } from "./helpers/script-runner-double";

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

function writeCode(path: string, content: string): string {
  const p = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `await sdk.write('${p}', ${JSON.stringify(content)})`;
}

async function run(code: string, ctx: ToolContext): Promise<ToolExecuteResult> {
  return await createWorkflowTool().execute({ code }, ctx);
}

beforeEach(() => {
  /**
   * 第 103 波：`workflow` 的脚本执行也搬到了 **Rust 侧 boa**（vitest 里没有 Tauri 运行时），
   * 所以这里装**测试替身**把 guest 代码跑起来、把**真实的** sdk 调起来 ——
   * 本文件钉的是"workflow 内的危险命令/受保护路径/覆盖确认**在生产路径上生效**"。
   * 替身与三层分工见 `src/test/helpers/script-runner-double.ts` 的文件头。
   */
  installScriptRunnerDouble();
  dir = mkdtempSync(join(tmpdir(), "codem-workflow-parity-"));
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

describe("WF-1: workflow 内的危险 bash 命令必须被拒绝执行", () => {
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
      "包在 workflow 里的危险命令绝不能被真的执行",
    ).not.toHaveBeenCalled();
    expect(result.output).toContain("refused");
    // 报明「为什么拒绝」：命中的危险模式必须出现在给模型看的文本里
    expect(result.output).toContain("Remove-Item");
    // 拒绝文案必须点名是 workflow 拒的（而不是笼统的 run_code），否则排查时会找错地方
    expect(result.output).toContain("workflow");
  });

  it("反向对照：只读命令仍然真的执行（修复不能是「一律拒绝」）", async () => {
    const analysis = analyzeBashCommand(SAFE_COMMAND);
    expect(analysis.classification, "夹具失效：安全命令竟被判为 dangerous").not.toBe("dangerous");

    const result = await run(
      `const r = ${bashCode(SAFE_COMMAND)}; console.log(r.stdout);`,
      makeCtx({ securityMode: "auto" }),
    );

    expect(mocks.executeCommand, "安全命令必须照常执行").toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand.mock.calls[0][0]).toBe(SAFE_COMMAND);
    expect(result.output, "命令真实跑过时，它的 stdout 必须回到模型手里").toContain("ok");
  });

  it("fail-closed：分析器抛错时同样不执行（拿不准 ≠ 安全）", async () => {
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

  it("同一道闸门也装在 execWorkflow 上（provider 路径不能漏）", async () => {
    const out = await execWorkflow(bashCode(DANGEROUS_COMMAND));
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(out).toContain("refused");
  });
});

describe("WF-2: workflow 内的写入必须走受保护路径 + 覆盖确认", () => {
  it("受保护路径（.env）→ 拒绝，且 writeFile / readFile 都没被调用", async () => {
    const target = join(dir, ".env");
    /**
     * 让"若闸门被删掉会怎样"变成**可判定的**：读盘成功 + 内容差异大 + auto 模式，
     * 于是没有闸门时它会一路走到 `writeFile`（闸门存在时才在更早处被拦下）。
     * 否则桩返回 undefined 会让路径在别处抛错 —— 那样本条断言就变成了"因为别的原因没写"。
     */
    mocks.readFile.mockResolvedValue(EXISTING);

    const result = await run(writeCode(target, "SECRET=1\n"), makeCtx({ securityMode: "auto" }));

    expect(
      mocks.writeFile,
      "受保护路径在建任何东西之前就该拒绝 —— 一个字节都不许写",
    ).not.toHaveBeenCalled();
    expect(
      mocks.readFile,
      "受保护路径的判定在覆盖确认之前，不该白读一次盘",
    ).not.toHaveBeenCalled();
    expect(result.output).toContain("protected");
    expect(result.output).toContain(".env");
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

    const result = await run(writeCode(file, UNRELATED), ctx);

    expect(confirmCalls, "覆盖确认必须被真正走到（否则本用例只是「没触发确认」）").toBe(1);
    expect(mocks.writeFile, "用户拒绝后不得写盘").not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8"), "真实磁盘上的文件不许变").toBe(before);
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

    await run(writeCode(file, UNRELATED), ctx);

    expect(confirmCalls).toBe(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const passed = mocks.writeFile.mock.calls[0];
    expect(passed[0]).toBe(file);
    expect(passed[1]).toBe(UNRELATED);
    // 原有的 workspace 沙箱参数必须保留（S5 检查在 file-api 内）
    expect(passed[2]).toEqual({ workspace: dir });
  });

  it("新建文件（读不到）不需要确认 —— 与 write 工具一致（不许把新建也变成打扰）", async () => {
    const file = join(dir, "brand-new.txt");
    let confirmCalls = 0;
    const ctx = makeCtx({
      securityMode: "ask",
      onWriteConfirm: async (): Promise<WriteConfirmResult> => {
        confirmCalls++;
        return { action: "reject" };
      },
    });
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    await run(writeCode(file, UNRELATED), ctx);

    expect(confirmCalls, "新建文件没有可覆盖的内容，不该弹确认").toBe(0);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false); // writeFile 是桩，没有真写盘
  });
});

describe("WF-3: workflow 的契约声明必须与它的能力一致", () => {
  it("契约声明为 system（与 bash / run_code / terminal_* 同档），因此被 isShellLike 纳入", () => {
    const tool = createWorkflowTool();
    // 反向对照：字段存在（否则下面的断言会「因为 undefined」而假绿）
    expect(tool.contract).toBeTruthy();
    expect(tool.contract!.sideEffectScope).toBe("system");
    expect(tool.contract!.accessScope).toBe("system");

    const resolved = resolveToolContract(tool.contract, "workflow");
    expect(
      isShellLike("workflow", resolved),
      "声明成 system ⇒ 计划模式按「可能写」处理（原来声明 workspace 时它同时低估了能力）",
    ).toBe(true);
  });
});
