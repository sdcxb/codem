/**
 * 权限语义兑现判据 —— PRM-1..8。
 *
 * ## 这一刀的主张
 *
 * 1. **拒绝理由真的到达模型**：审批卡发出 `{ kind: "deny", reason }` → `PermissionResult.reason`
 *    → `agentic-loop` 的 `denyMessage` → 工具结果（模型可见）。以前理由在 `App.tsx` 的
 *    映射里就蒸发了，`PermissionResult` 连字段都没有。
 * 2. **「始终允许」不是安慰剂**：引擎读 `PermissionResult.alwaysAllow`，按**会话 +
 *    精确 `(tool, resource)`** 记住放行；bash 危险命令升级**不再覆盖**用户明确放行过的命令。
 * 3. **能力位如实**：只在"下一次真的还会问、且存得进去"的入口才画那个按钮
 *    （`ask` 模式 + 有 resource + 有会话）；远端一次性通道（AB-4）保持不画。
 *
 * ## 为什么测试必须用**危险 bash**
 *
 * 默认 `build` agent 是 `{ tool: "*", action: "allow" }`（`agent.ts`），权限规则表在
 * `evaluate()` 里排在 agent 之后 —— 今天真正会弹审批的**唯一来源**是 bash 危险命令升级
 * （`agentic-loop.ts` 的 `evaluateWithBashAnalysis`）。用 `write`/`read` 之类做场景
 * 根本走不到 `onPermissionRequest`，测出来的绿是假的。
 *
 * ## 变异自证（每条都能被弄红）
 *
 * - 删掉引擎侧 `setAlwaysAllow` 调用 ⇒ PRM-1 第二次又问（`seen` 变 2）；
 * - 把记忆写成通配（`resource: "*"`）或按 tool 记忆 ⇒ PRM-2 换一条命令不再问；
 * - 把会话判断去掉 ⇒ PRM-1b（另一个会话）/ PRM-1c（没有会话）红；
 * - 删掉 `describeUserDenial` 的拼接 / 无条件加 `— user reason:` ⇒ PRM-5 / PRM-6 红；
 * - 去掉理由截断 ⇒ PRM-5b 红；
 * - App 里手写 `action` 映射（丢掉 reason）⇒ PRM-7 的源码契约红；
 * - 委派入口不打开 `rejectReason` ⇒ PRM-8 找不到理由输入框。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AgenticLoop } from "../core/llm/agentic-loop";
import {
  PermissionEvaluator,
  PermissionManager,
  describeUserDenial,
  type PermissionRequest,
  type PermissionResult,
} from "../core/permission/permission";
import { alwaysAllowOffered, toPermissionResult } from "../components/approval-decision";
import { PermissionDialog } from "../components/PermissionDialog";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** 危险 bash（PowerShell 侧）：`analyzeBashCommand` 判 dangerous ⇒ 唯一会弹审批的入口 */
const DANGEROUS = "Remove-Item -Recurse -Force C:\\tmp\\perm-target";
/** 另一条危险命令（证明记忆只覆盖**精确 resource**，不是整个 tool） */
const DANGEROUS_2 = 'Invoke-Expression "Write-Host something"';

type CheckResult = { allowed: boolean; denyMessage?: string };

function makeLoop(permission: PermissionManager = new PermissionManager()) {
  const provider = { id: "test", stream: async function* () {}, complete: async () => "" } as any;
  const loop = new AgenticLoop(provider, new Map() as any, {} as any) as any;
  // 注入**新实例**（避免进程级单例把上一个用例的"始终允许"记忆带过来）
  loop.setContext({ get: (name: string) => (name === "permission" ? permission : undefined) });
  return { loop, permission };
}

/** 接上 onPermissionRequest，并记录"问了几次" */
function wire(
  loop: any,
  respond: (request: PermissionRequest, seq: number) => PermissionResult,
): PermissionRequest[] {
  const seen: PermissionRequest[] = [];
  loop.updateConfig({
    securityMode: "ask",
    enablePermissions: true,
    onPermissionRequest: async (request: PermissionRequest) => {
      seen.push(request);
      return respond(request, seen.length);
    },
  });
  return seen;
}

const check = (
  loop: any,
  tool: string,
  args: Record<string, unknown>,
  sessionId = "s1",
): Promise<CheckResult> => loop.pipelineHost().checkPermission(tool, args, { sessionId });

describe("PRM：权限语义兑现", () => {
  beforeEach(() => {
    localStorage.clear();
    cleanup();
  });

  it("PRM-1 「始终允许」真的生效：同一会话 + 同一条命令不再问，且直接放行", async () => {
    const { loop } = makeLoop();
    const seen = wire(loop, (request) => ({
      requestId: request.id,
      action: "allow",
      alwaysAllow: true,
    }));

    const first = await check(loop, "bash", { command: DANGEROUS });
    expect(first.allowed).toBe(true);
    expect(seen, "第一次必须弹审批").toHaveLength(1);

    const second = await check(loop, "bash", { command: DANGEROUS });
    expect(second.allowed).toBe(true);
    expect(seen, "放过行之后第二次不该再问（否则按钮就是安慰剂）").toHaveLength(1);
  });

  it("PRM-1b 记忆是会话级的：另一个会话的同一条命令仍然要问", async () => {
    const { loop } = makeLoop();
    const seen = wire(loop, (request) => ({
      requestId: request.id,
      action: "allow",
      alwaysAllow: true,
    }));

    await check(loop, "bash", { command: DANGEROUS }, "s1");
    expect(seen).toHaveLength(1);

    const otherSession = await check(loop, "bash", { command: DANGEROUS }, "s2");
    expect(otherSession.allowed).toBe(true);
    expect(seen, "A 会话放过行的命令不该在 B 会话被默认放行").toHaveLength(2);
  });

  it("PRM-1c 没有会话就不写记忆（否则等于进程级放行）", async () => {
    const { loop } = makeLoop();
    const seen = wire(loop, (request) => ({
      requestId: request.id,
      action: "allow",
      alwaysAllow: true,
    }));

    // ctx 里没有 sessionId：不记（`setAlwaysAllow` 只有在知道会话时才写）
    const noSession: CheckResult = await loop
      .pipelineHost()
      .checkPermission("bash", { command: DANGEROUS }, {});
    expect(noSession.allowed).toBe(true);

    const later = await check(loop, "bash", { command: DANGEROUS }, "s1");
    expect(later.allowed).toBe(true);
    expect(seen, "无会话的那次不许留下会作用于所有会话的记忆").toHaveLength(2);
  });

  it("PRM-2 记忆只覆盖精确 resource：换一条命令必须重新问", async () => {
    const { loop } = makeLoop();
    const seen = wire(loop, (request) => ({
      requestId: request.id,
      action: "allow",
      alwaysAllow: true,
    }));

    await check(loop, "bash", { command: DANGEROUS });
    expect(seen).toHaveLength(1);

    const other = await check(loop, "bash", { command: DANGEROUS_2 });
    expect(other.allowed).toBe(true);
    expect(seen, "换一条命令还放行 ⇒ 记忆写成了通配（会盖过 S2 硬 deny）").toHaveLength(2);
  });

  it("PRM-3 能力位如实：只有 ask 模式 + 有 resource + 有会话才画「始终允许」", () => {
    expect(alwaysAllowOffered("ask", "C:\\proj\\a.txt", "s1")).toBe(true);
    expect(alwaysAllowOffered("ask", undefined, "s1"), "没有 resource 就存不进记忆").toBe(false);
    expect(alwaysAllowOffered("ask", "C:\\proj\\a.txt", undefined), "没有会话就写不进记忆").toBe(false);
    expect(alwaysAllowOffered("auto", "C:\\proj\\a.txt", "s1"), "auto 会对危险命令二次裁决").toBe(false);
    expect(alwaysAllowOffered("full", "C:\\proj\\a.txt", "s1"), "full 根本不询问").toBe(false);

    const app = read("src/App.tsx");
    expect(app, "托盘能力位必须走这个判断，不许内联 true").toContain(
      "alwaysAllowOffered(securityMode, req.resource, req.sessionId)",
    );
    expect(app, "App 里不该有写死的「始终允许」能力位").not.toContain("alwaysAllow: true");
  });

  it("PRM-4 会话级 + 精确匹配，且不穿 S2：别的会话/别的命令都不认，受保护路径仍是 deny", () => {
    const evaluator = new PermissionEvaluator();
    evaluator.setAlwaysAllow("bash", DANGEROUS, "allow", "s1");

    // 用不走 build agent 的 agentId 看规则表本身（否则 agent 的 allow-all 会先把结果吃掉）
    expect(evaluator.evaluate("bash", DANGEROUS, "", "s1"), "本会话命中").toBe("allow");
    expect(evaluator.evaluate("bash", DANGEROUS, "", "s2"), "别的会话不许穿").toBe("ask");
    expect(evaluator.evaluate("bash", DANGEROUS_2, "", "s1"), "别的命令不许穿").toBe("ask");
    // S2：受保护路径的硬 deny 还在（记忆没有把它变成 allow）
    expect(evaluator.evaluate("write", "project/.env", "")).toBe("deny");
    expect(evaluator.evaluate("edit", "project/.git/config", "")).toBe("deny");
  });

  it("PRM-4b Windows 冒号路径不被截断（旧 key.split(\":\") 的回归）", () => {
    const evaluator = new PermissionEvaluator();
    evaluator.setAlwaysAllow("bash", "Get-Content C:\\a\\b.txt", "allow", "s1");

    expect(evaluator.getAlwaysAllow("bash", "Get-Content C:\\a\\b.txt", "s1")).toBe("allow");
    expect(
      evaluator.getAlwaysAllow("bash", "Get-Content C", "s1"),
      "把 `:` 当分隔符会把 resource 截成 `Get-Content C` —— 那会让不相干的前缀也命中",
    ).toBeUndefined();
  });

  it("PRM-5 拒绝理由进入 denyMessage：带上原文、单行、有上限", async () => {
    const { loop } = makeLoop();
    wire(loop, (request) => ({
      requestId: request.id,
      action: "deny",
      reason: "这条命令会删数据\n  请不要执行 rm -rf",
    }));

    const result = await check(loop, "bash", { command: DANGEROUS });
    expect(result.allowed).toBe(false);
    expect(result.denyMessage, "固定文案保留").toContain('Permission denied by user for tool "bash"');
    expect(result.denyMessage, "用户理由必须到达模型可见文本").toContain(
      "这条命令会删数据 请不要执行 rm -rf",
    );
    expect(result.denyMessage, "多行理由要被压成一行").not.toMatch(/\n/);
    expect(result.denyMessage!.length, "不能把整段理由灌进上下文").toBeLessThanOrEqual(400);
  });

  it("PRM-5b 超长理由被截断（带省略号）", () => {
    const message = describeUserDenial("bash", "删".repeat(500));
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBeLessThan(400);
    expect(message).toContain('Permission denied by user for tool "bash"');
  });

  it("PRM-6 没有理由时文案与今天逐字一致（不追加空冒号）", async () => {
    const { loop } = makeLoop();
    wire(loop, (request) => ({ requestId: request.id, action: "deny" }));

    const result = await check(loop, "bash", { command: DANGEROUS });
    expect(result.denyMessage).toBe('Permission denied by user for tool "bash"');
    expect(describeUserDenial("bash", "")).toBe('Permission denied by user for tool "bash"');
    expect(describeUserDenial("bash", "  \n\t ")).toBe('Permission denied by user for tool "bash"');
  });

  it("PRM-7 卡出口 → 权限结果：reason / alwaysAllow 都不丢，且 App 走唯一映射", () => {
    expect(toPermissionResult("p1", { kind: "deny", reason: "别动这个文件" })).toEqual({
      requestId: "p1",
      action: "deny",
      alwaysAllow: false,
      reason: "别动这个文件",
    });
    expect(toPermissionResult("p1", { kind: "deny" })).toEqual({
      requestId: "p1",
      action: "deny",
      alwaysAllow: false,
    });
    expect(toPermissionResult("p1", { kind: "allow" })).toEqual({
      requestId: "p1",
      action: "allow",
      alwaysAllow: false,
    });
    expect(toPermissionResult("p1", { kind: "always-allow" }).alwaysAllow).toBe(true);

    const app = read("src/App.tsx");
    expect(app, "前台托盘的结论必须经唯一映射交给引擎").toContain(
      "pendingPermission.resolve(toPermissionResult(id, outcome))",
    );
    expect(
      app,
      "App 里不许再手写 action 映射（理由就是在那里丢的）",
    ).not.toContain('outcome.kind === "allow" || outcome.kind === "always-allow"');
  });

  it("PRM-8 委派入口打开理由输入并把理由送回；远端一次性入口保持一步拒绝", () => {
    const request: PermissionRequest = {
      id: "perm-d",
      sessionId: "s1",
      tool: "bash",
      input: { command: DANGEROUS },
      resource: DANGEROUS,
      timestamp: 0,
      title: "[委派任务] bash",
    };

    const delegated: Array<{ allow: boolean; alwaysAllow?: boolean; reason?: string }> = [];
    render(
      <PermissionDialog
        request={request}
        rejectReason
        onResolve={(allow, alwaysAllow, reason) => delegated.push({ allow, alwaysAllow, reason })}
      />,
    );
    fireEvent.click(screen.getByText("拒绝"));
    const input = document.querySelector(".decision-tray-reject-input") as HTMLInputElement;
    expect(input, "委派入口打开 rejectReason 后必须有理由输入框").not.toBeNull();
    fireEvent.change(input, { target: { value: "这是生产库，别删" } });
    fireEvent.click(screen.getByText("确认拒绝"));
    expect(delegated).toEqual([{ allow: false, alwaysAllow: false, reason: "这是生产库，别删" }]);
    cleanup();

    // 远端：`answerApproval()` 只有 allow/deny（AB-4）⇒ 理由没有出口，就不画输入框
    const remote: Array<{ allow: boolean; alwaysAllow?: boolean; reason?: string }> = [];
    render(
      <PermissionDialog
        request={request}
        onResolve={(allow, alwaysAllow, reason) => remote.push({ allow, alwaysAllow, reason })}
      />,
    );
    expect(document.querySelector(".decision-tray-reject-input"), "远端没有理由通道").toBeNull();
    fireEvent.click(screen.getByText("拒绝"));
    expect(remote).toEqual([{ allow: false, alwaysAllow: false, reason: undefined }]);
  });
});
