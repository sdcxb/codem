/**
 * 回归测试：PowerShell 命令参数安全转义工具
 *
 * 背景（对标审计发现）：
 * Codem 通过 Tauri execute_command 以 `powershell -Command ...` 执行原生命令。
 * 之前 git 命令把参数直接拼进双引号字符串：
 *   - `git -C "${cwd}" rev-parse HEAD^{tree}`
 *   PowerShell 把 `^{tree}` 的 `{tree}` 当 scriptblock → 报错
 *   "ScriptBlock should only be specified as a value of the Command parameter"
 *   （日志中 FileChangeTracker.start failed 的根因——文件变更追踪一直失效）
 *   - `git commit -m "${message}"` 的 message 含 `$`/反引号/`;` 时会被解释（注入风险）
 *
 * 修复：ps-command.ts 提供 PowerShell 单引号转义 + buildGitCommand。
 */
import { describe, it, expect } from "vitest";
import { psQuote, maybePsQuote, buildGitCommand } from "../core/utils/ps-command";

describe("ps-command: PowerShell 安全转义", () => {
  it("PS-001: HEAD^{tree} 必须被单引号包裹（修复 scriptblock 解析错误）", () => {
    const quoted = maybePsQuote("HEAD^{tree}");
    expect(quoted).toBe("'HEAD^{tree}'");
  });

  it("PS-002: 普通参数不加引号（可读性）", () => {
    expect(maybePsQuote("rev-parse")).toBe("rev-parse");
    expect(maybePsQuote("--is-inside-work-tree")).toBe("--is-inside-work-tree");
    expect(maybePsQuote("C:\\repo\\path")).toBe("C:\\repo\\path");
  });

  it("PS-003: 含空格/单引号的参数被安全转义", () => {
    // 空格需要引号
    expect(psQuote("C:\\my repo")).toBe("'C:\\my repo'");
    // 内嵌单引号按 PowerShell 规则翻倍
    expect(psQuote("it's")).toBe("'it''s'");
    // commit message 含特殊字符
    expect(psQuote("feat: add $HOME; rm -rf /")).toContain("'");
  });

  it("PS-004: buildGitCommand 生成 PowerShell 安全命令", () => {
    // cwd 无元字符时保持可读（不加引号）；含 ^ 的 HEAD^{tree} 被单引号包裹
    const cmd = buildGitCommand("C:\\mimo-gui", ["rev-parse", "HEAD^{tree}"]);
    expect(cmd).toBe(`git -C C:\\mimo-gui rev-parse 'HEAD^{tree}'`);
    // 含单引号的 commit message
    const cmd2 = buildGitCommand("C:\\mimo-gui", ["commit", "-m", "fix: user's quote"]);
    expect(cmd2).toBe(`git -C C:\\mimo-gui commit -m 'fix: user''s quote'`);
    // cwd 含空格时被引号包裹
    const cmd3 = buildGitCommand("C:\\my repo", ["status"]);
    expect(cmd3).toBe(`git -C 'C:\\my repo' status`);
  });

  it("PS-005: 空参数转义为空单引号对", () => {
    expect(maybePsQuote("")).toBe("''");
  });
});
