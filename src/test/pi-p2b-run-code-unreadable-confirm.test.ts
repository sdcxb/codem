/**
 * Pi P2 补充：`sdk.write` **读不到现有内容时必须仍然去问**，而不是当成"新文件"。
 *
 * ## 缺陷（修复前）
 *
 * `confirmWriteIfNeeded` 的读盘 catch 是空的：
 *
 *     let existingContent: string | null = null;
 *     try { existingContent = await readFile(path); }
 *     catch {  // 文件不存在 / 读不到 —— 按新建处理
 *     }
 *     if (existingContent === null || existingContent.length === 0) return { ok: true };
 *
 * 于是**任何**读失败都走"新建"分支 ⇒ 直接放行、**跳过覆盖确认**。这是这一层的 fail-open，
 * 而且窗口是真实的：二进制/超大文件、权限不足、引擎暂时不可用都会让 `read_file` 抛错，
 * 而 `write_file` 可能照样写得下去 —— 用户在被覆盖之前**一次都没被问过**。
 *
 * ## 修法与方向
 *
 * 只有**能确认"路径不存在"**才当新建；**判不出来一律按"可能已存在"处理**（有确认通道就去问）。
 * 所以文本判据的方向是保守的：它误判的后果是"多问一次"，不是"少问一次"。
 *
 * ## 断言落在哪
 *
 * 只断言"源码里有 isMissingPathError"没有意义 —— 把调用点删掉测试照样绿。
 * 这里断言 (a) 确认回调**有没有被调用**、(b) `writeFile` **有没有被调用**、
 * (c) 返回值里有没有把那件事说出来。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext, WriteConfirmResult, ToolExecuteResult } from "../core/llm/tools";

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

import { createRunCodeTool } from "../core/llm/tools/run-code";

let dir: string;

/** 读失败，但**不是**"路径不存在"——例如权限不足（`os error 5`） */
const UNREADABLE_NOT_MISSING = "Failed to read C:\\secret\\big.bin: os error 5 (拒绝访问)";
/** 真正的"路径不存在" */
const MISSING = "Failed to read C:\\nope.txt: os error 2";
/** Node 侧惯例写法（测试桩与部分 JS 路径用这个） */
const MISSING_NODE_STYLE = "ENOENT: no such file or directory, open 'C:\\nope.txt'";

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

/** 脚本里用单引号字面量，省掉反斜杠转义 */
function writeCode(path: string): string {
  const p = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `await sdk.write('${p}', 'new content')`;
}

async function run(code: string, ctx: ToolContext): Promise<ToolExecuteResult> {
  return await createRunCodeTool().execute({ code }, ctx);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codem-pi-p2b-"));
  mocks.executeCommand.mockReset();
  mocks.writeFile.mockReset();
  mocks.readFile.mockReset();
  mocks.globSearch.mockReset();
  mocks.grepSearch.mockReset();
  mocks.executeCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.globSearch.mockResolvedValue([]);
  mocks.grepSearch.mockResolvedValue([]);
});

describe("run_code / sdk.write：读不到现有的内容", () => {
  it("P2B-1 fail-closed：读失败但**不是**不存在时，必须先问用户；拒绝则一个字节都不写", async () => {
    const target = join(dir, "existing.bin");
    mocks.readFile.mockRejectedValue(new Error(UNREADABLE_NOT_MISSING));

    const confirm = vi.fn(async (): Promise<WriteConfirmResult> => ({ action: "reject" }));
    const result = await run(writeCode(target), makeCtx({ securityMode: "ask", onWriteConfirm: confirm }));

    expect(confirm, "读不到不能当成「文件不存在」而跳过确认 —— 那是 fail-open").toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ filePath: target, existingContent: "" });
    expect(mocks.writeFile, "用户拒绝了写入，就不能写盘").not.toHaveBeenCalled();
    expect(String(result.output)).toContain("rejected");
  });

  it("P2B-2 反向对照：确认之后（accept）真的写下去", async () => {
    const target = join(dir, "existing.bin");
    mocks.readFile.mockRejectedValue(new Error(UNREADABLE_NOT_MISSING));

    const confirm = vi.fn(async (): Promise<WriteConfirmResult> => ({ action: "accept" }));
    await run(writeCode(target), makeCtx({ securityMode: "ask", onWriteConfirm: confirm }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][0]).toBe(target);
  });

  it("P2B-3 反向对照：**确实不存在**（os error 2）时不需要确认 —— 不许把新建也变成打扰", async () => {
    const target = join(dir, "brand-new.txt");
    mocks.readFile.mockRejectedValue(new Error(MISSING));

    const confirm = vi.fn(async (): Promise<WriteConfirmResult> => ({ action: "accept" }));
    await run(writeCode(target), makeCtx({ securityMode: "ask", onWriteConfirm: confirm }));

    expect(confirm, "文件确实不存在 ⇒ 新建 ⇒ 不该打扰用户").not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it("P2B-4 反向对照：Node 惯例的 ENOENT 同样算「不存在」", async () => {
    const target = join(dir, "brand-new-2.txt");
    mocks.readFile.mockRejectedValue(new Error(MISSING_NODE_STYLE));

    const confirm = vi.fn(async (): Promise<WriteConfirmResult> => ({ action: "accept" }));
    await run(writeCode(target), makeCtx({ securityMode: "ask", onWriteConfirm: confirm }));

    expect(confirm, "ENOENT 就是「不存在」，不能因为判不出来就去打扰用户").not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it("P2B-5 读不到且无从确认（auto 模式）时放行，但必须**留下痕迹**（不许静默）", async () => {
    const target = join(dir, "existing.bin");
    mocks.readFile.mockRejectedValue(new Error(UNREADABLE_NOT_MISSING));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const confirm = vi.fn(async (): Promise<WriteConfirmResult> => ({ action: "reject" }));
      await run(writeCode(target), makeCtx({ securityMode: "auto", onWriteConfirm: confirm }));

      expect(confirm, "auto 模式不弹确认（与 write 工具一致）").not.toHaveBeenCalled();
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      const traced = warn.mock.calls.some((call) => String(call[0]).includes("could not read the existing content"));
      expect(traced, "读不到却放行这件事必须留痕，否则事后无从排查").toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
