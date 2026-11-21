/**
 * 第 15 轮：危险命令闸门的「活规则」判据
 *
 * 背景（实测 bug，两个同时存在）：
 * 1. `bash-analyzer.ts` 的 unix 危险清单里**一个删除命令都没有** ⇒ `rm -rf` 被判 write；
 * 2. `PermissionEvaluator.evaluate()` 先问 agent registry，而 build agent 是通配
 *    `{tool:"*", action:"allow"}` ⇒ 默认安全规则（bash rm -rf → ask、write .git → deny）
 *    **永远走不到**，ask 模式对 bash 完全放行。
 *
 * 这组判据不使用 mock 的 agent registry —— 要守的正是「真实装配下规则有效」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeBashCommand, evaluateWithBashAnalysis } from "../core/permission/bash-analyzer";
import { getPermissionManager } from "../core/permission/permission";
import { evaluateWithSecurityMode } from "../core/permission/security-mode";

const DESTRUCTIVE: Array<[string, string]> = [
  ["rm -rf /tmp/codem-probe", "递归删除"],
  ["rm -fr build", "递归删除（参数顺序）"],
  ["rm -r dir", "递归删除"],
  ["rm -f a.txt", "强制删除"],
  ["del /s C:\\temp", "Windows 递归删除"],
  ["rd /s /q C:\\temp", "Windows 递归删除"],
  ["git clean -fdx", "清理未跟踪文件"],
  ["git push --force origin main", "强推"],
  ["git reset --hard HEAD~1", "硬重置"],
  ["sudo ls", "提权"],
  ["chmod -R 777 .", "改权限"],
  ["shutdown -h now", "关机"],
  ["truncate -s 0 data.bin", "清零文件"],
  ["shred secret.txt", "不可恢复删除"],
  [":(){ :|:& };:", "fork bomb"],
];

describe("DANGER-15：破坏性命令必须被判 dangerous（ask 模式才会问）", () => {
  it.each(DESTRUCTIVE)("%s（%s）", (cmd) => {
    expect(analyzeBashCommand(cmd).classification, `${cmd} 应判 dangerous`).toBe("dangerous");
    expect(evaluateWithBashAnalysis(cmd, "allow").action, "危险命令必须把 allow 升级为 ask").toBe("ask");
  });

  it("普通命令不被误判", () => {
    expect(analyzeBashCommand("ls -la").classification).toBe("readonly");
    expect(analyzeBashCommand("rm a.txt").classification).toBe("write");
    expect(analyzeBashCommand("git status").classification).toBe("readonly");
    expect(analyzeBashCommand("npm test").classification).toBe("write");
  });
});

describe("DANGER-15：复合命令 / 命令位置锚定 / Windows 系统命令", () => {
  it.each([
    ["rm -v -r dir", "flag 分离的递归删除"],
    ["find . -delete", "find -delete 不能判 readonly"],
    ["echo hi; Remove-Item -Recurse -Force C:\\x", "复合命令的第二段是删除"],
    ["cd x; Remove-Item -Force y", "复合命令 + PowerShell cmdlet"],
    ["powershell -Command \"Remove-Item -Recurse -Force C:\\x\"", "PS 外壳"],
    ["pwsh -c \"remove-item -force x\"", "小写 cmdlet + pwsh"],
    ["del C:\\x.txt", "单文件删除"],
    ["git branch -D feat", "强删分支"],
    ["git checkout .", "丢弃全部工作区改动"],
    ["git stash drop", "丢弃暂存"],
    ["kill -9 -1", "杀全部进程"],
    ["format D:", "格式化"],
    ["diskpart", "磁盘分区工具"],
    ["reg delete HKLM\\X /f", "删注册表"],
    ["cat /dev/zero > /dev/sda", "直接写块设备"],
  ])("%s（%s）", (cmd) => {
    expect(analyzeBashCommand(cmd).classification, `${cmd} 应判 dangerous`).toBe("dangerous");
  });

  it.each([
    ["grep -rn \"rm -rf\" src/", "引号里的 rm -rf 只是搜索词"],
    ["git log --grep=shutdown", "grep 参数里的 shutdown"],
    ["git commit -m \"fix chmod handling\"", "提交信息里的 chmod"],
    ["echo \"su support removed\"", "输出文本里的 su"],
  ])("%s 不许误报（%s）", (cmd) => {
    expect(analyzeBashCommand(cmd).classification, `${cmd} 不应判 dangerous`).not.toBe("dangerous");
  });
});

describe("DANGER-15：危险命令只认原文精确的「始终允许」", () => {
  it("通配条目能匹配，但不能抑制危险命令升级", () => {
    const ev = getPermissionManager().getEvaluator();
    ev.setAlwaysAllow("bash", "rm -rf *", "allow", "sess-wild-15");
    expect(ev.getAlwaysAllow("bash", "rm -rf /", "sess-wild-15"), "通配记忆本身仍可匹配（兼容旧行为）").toBe("allow");
    expect(ev.getExactAlwaysAllow("bash", "rm -rf /", "sess-wild-15"), "危险命令升级只认精确原文").toBeUndefined();
  });

  it("同一会话 + 同一条命令原文的「始终允许」仍然生效（不误伤用户显式放行）", () => {
    const ev = getPermissionManager().getEvaluator();
    ev.setAlwaysAllow("bash", "rm -rf /tmp/exact-probe", "allow", "sess-exact-15");
    expect(ev.getExactAlwaysAllow("bash", "rm -rf /tmp/exact-probe", "sess-exact-15")).toBe("allow");
    expect(ev.getExactAlwaysAllow("bash", "rm -rf /tmp/other", "sess-exact-15")).toBeUndefined();
  });
});

describe("DANGER-15：真实装配下默认安全规则不许被 agent 通配 allow 短路", () => {
  it("bash rm -rf 在 build agent 下仍返回 ask", () => {
    const ev = getPermissionManager().getEvaluator();
    expect(ev.evaluate("bash", "rm -rf /tmp/codem-probe", "build")).toBe("ask");
    expect(ev.evaluate("bash", "rm -rf /tmp/codem-probe; echo done", "build")).toBe("ask");
    expect(ev.evaluate("bash", "sudo ls", "build")).toBe("ask");
  });

  it("受保护路径的硬拒绝仍然生效（write .git / node_modules）", () => {
    const ev = getPermissionManager().getEvaluator();
    expect(ev.evaluate("write", "/repo/.git/config", "build")).toBe("deny");
    expect(ev.evaluate("edit", "/repo/node_modules/x.js", "build")).toBe("deny");
    expect(ev.evaluate("write", "/repo/src/a.ts", "build")).toBe("allow");
  });

  it("ask 模式自身只透传 normalEvaluation（升级由 bash 分析器负责，二者要接力）", () => {
    /* 这一条守的是分工：evaluateWithSecurityMode 不负责危险识别；
       危险识别 + 升级由 evaluateWithBashAnalysis 完成（上面两组已断言），
       所以「最终会问」= evaluate() 返回 ask 或 analyzer 升级为 ask。 */
    expect(evaluateWithSecurityMode("ask", "bash", "rm -rf /tmp/x", "ask")).toBe("ask");
    expect(evaluateWithSecurityMode("ask", "bash", "ls -la", "allow")).toBe("allow");
    expect(evaluateWithSecurityMode("ask", "bash", "rm -rf /tmp/x", "allow")).toBe("allow");
    expect(evaluateWithBashAnalysis("rm -rf /tmp/x", "allow").action).toBe("ask");
  });
});

describe("DANGER-15：没有审批通道的终端工具也必须过同一道闸门", () => {
  it("terminal_send 在 ask/auto 下拒绝危险命令（full 模式才放行）", () => {
    const src = readFileSync(join(process.cwd(), "src/core/llm/tools/terminal-tools.ts"), "utf8");
    expect(src, "必须复用 refuseDangerousCommand").toContain("refuseDangerousCommand(text");
    expect(src, "full 模式不拦（用户显式放弃审批）").toMatch(/securityMode !== "full"/);
  });
});
