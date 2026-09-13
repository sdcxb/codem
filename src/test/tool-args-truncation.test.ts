/**
 * 工具参数截断守卫契约（第 66 波）。
 *
 * 真实事故（用户控制台日志）：
 *   `SyntaxError: Unterminated string in JSON at position 6648 / 6348 / 6001 / 2080`
 *   —— 模型一次 `write` 一个 6–10KB 的 Python 脚本，参数 JSON 在**输出上限处被截断**，
 *   同一个 `write` 反复失败，任务卡住，用户看到一屏报错。
 *
 * 这条不只是"体验问题"，还是**数据安全问题**：旧逻辑在截断时会用正则兜底抽出
 * `content: ""`（截断时结尾引号还没生成 → 匹配不到），于是 `write` 会拿着空内容执行；
 * 对已存在的文件就是**清空**（覆盖保护在 auto/full 模式下不拦）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildUnparsableArgsError, isContentBearingTool, CONTENT_BEARING_TOOLS } from "../core/llm/tool-args-guard";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("工具参数截断守卫（第 66 波）", () => {
  it("ARGS-1: 内容型工具被识别（它们的参数里有「要写下去的东西」）", () => {
    for (const t of ["write", "edit", "multi_edit", "patch", "apply_patch"]) {
      expect(isContentBearingTool(t), t).toBe(true);
    }
    for (const t of ["read", "grep", "bash", "list_sessions"]) {
      expect(isContentBearingTool(t), t).toBe(false);
    }
    expect(CONTENT_BEARING_TOOLS.size).toBeGreaterThanOrEqual(5);
  });

  it("ARGS-2: 错误文本必须讲清「发生了什么 / 没执行 / 怎么重试」", () => {
    const msg = buildUnparsableArgsError("write", 6648, "Unterminated string in JSON at position 6648");
    expect(msg, "说明原因").toMatch(/截断|没能解析/);
    expect(msg, "明确这次没执行").toMatch(/没有执行/);
    expect(msg, "给出分块写入的办法").toMatch(/append: true/);
    expect(msg, "提醒不要原样重发").toMatch(/不要原样重发/);
    expect(msg, "带上原始长度便于判断是否被截断").toContain("6648");
  });

  it("ARGS-2b: 结束原因是 length 时要**确认**截断（不让用户猜）", () => {
    const confirmed = buildUnparsableArgsError("write", 6648, "Unterminated string", "length");
    expect(confirmed).toMatch(/已确认/);
    expect(confirmed).toMatch(/length/);
    const other = buildUnparsableArgsError("write", 100, "boom", "stop");
    expect(other).not.toMatch(/已确认/);
    expect(other).toMatch(/本次结束原因：stop/);
  });

  it("ARGS-3: 非内容型工具给「拆小」的建议，而不是分块写入", () => {
    const msg = buildUnparsableArgsError("bash", 1200);
    expect(msg).toMatch(/拆成多次更小的调用/);
    expect(msg).not.toMatch(/append: true/);
  });

  it("ARGS-4: 循环里**删掉了危险的「正则抽 path/content」兜底**，并改为拒绝执行", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    // 旧兜底：从残缺 JSON 里正则抽 content —— 截断时会得到空串，必须不复存在
    expect(loop, "不能再从残缺 JSON 里抽 content").not.toMatch(/contentMatch/);
    expect(loop, "不能再用 path 正则兜底").not.toMatch(/"path"\\s\*:\\s\*"/);
    // 新行为：标出 argsError 并拒绝执行
    expect(loop).toMatch(/\(ended as any\)\.argsError = /);
    expect(loop).toMatch(/Refusing to execute \$\{tc\.name\}/);
    expect(loop).toMatch(/buildUnparsableArgsError\(tc\.name, rawLen/);
    expect(loop, "要把这种拒绝执行记为结构化事件").toMatch(/recordLoopStop\(sessionId, "args_truncated"/);
    // 且被拒绝的调用必须从本批里剔除，避免用空参数执行
    expect(loop).toMatch(/currentToolCalls = currentToolCalls\.filter\(\(tc\) => !\(tc as any\)\.argsError\)/);
  });

  it("ARGS-5: provider 解析失败时要把原因与长度带出来（不再静默降级成空参数）", () => {
    const provider = read("src/core/llm/provider.ts");
    expect(provider).toMatch(/argsParseError/);
    expect(provider).toMatch(/rawLength: tc\.arguments\.length/);
    // 两处（正常结束 + 无 finish_reason 兜底）都要带
    expect(provider.match(/argsParseError/g)!.length).toBeGreaterThanOrEqual(4);
    const types = read("src/core/llm/types.ts");
    expect(types).toMatch(/argsParseError\?: string/);
  });

  it("ARGS-6: 输出上限不再是硬编码 4096，且默认可配置（尾随根因）", () => {
    const index = read("src/core/llm/index.ts");
    expect(index).toMatch(/DEFAULT_MAX_OUTPUT_TOKENS\s*=\s*8192/);
    expect(index, "要用常量而不是 4096").toMatch(/maxOutputTokens: [^\n]*DEFAULT_MAX_OUTPUT_TOKENS/);
    const processor = read("src/core/llm/processor.ts");
    expect(processor, "processor 不应再写死 4096").not.toMatch(/maxTokens:\s*this\.config\.maxTokens \?\? 4096/);
  });

  it("ARGS-7: write 支持 append 分块写入，且 content 不是字符串时直接报错（不覆盖文件）", () => {
    const tools = read("src/core/llm/tools.ts");
    expect(tools).toMatch(/append: \{/);
    expect(tools, "append 时跳过覆盖确认").toMatch(/existingContent\.length > 0 && !append/);
    expect(tools, "append 时拼接已有内容").toMatch(/append && existingContent \? existingContent \+ content : content/);
    expect(tools, "content 非字符串要拒绝（截断的典型形态）").toMatch(/typeof content !== "string"/);
    expect(tools, "指导语要教它分块").toMatch(/append: true/);
  });
});
