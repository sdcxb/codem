/**
 * 审批统一（第 3 步）判据 —— AU-1..AU-11。
 *
 * 这一步的主张：
 * 1. 审批卡只有**一份**实现（`packages/ui/src/approval-card.tsx`）：
 *    桌面前台托盘、桌面权限弹窗、桌面计划审批、桌面澄清表单、手机审批卡全部用它；
 * 2. 差异只能来自**数据**（`DecisionRequest`）与**能力位**（`DecisionCapabilities`）——
 *    不支持的能力**不出现**，不许画出来再禁用，也不许加 `isMobile`/`variant` 开关；
 * 3. 外壳（定位/遮罩/portal）留在宿主：同一张卡在桌面是 `position: fixed` 托盘，
 *    在权限弹窗的遮罩里由 `.permission-overlay .decision-tray` 把定位收回。
 *
 * 变异自证（每条都能被"把旧实现放回去 / 再加一层壳 / 开关式分支"弄红）：
 * - 把 `src/components/DecisionTray.tsx` 的 `<ApprovalCard>` 换回自带骨架 ⇒ AU-10 红；
 * - 把 `capabilities.alwaysAllow` 改成默认 true ⇒ AU-1 / AU-5 红；
 * - 删掉 `.permission-overlay .decision-tray` 定位回收 ⇒ AU-11 红；
 * - 把必填门控从"禁用提交"改回"点了再报错" ⇒ AU-7 红。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ApprovalCard,
  toApprovalDecision,
  type ApprovalDecisionRequest,
  type DecisionOutcome,
} from "../../packages/ui/src/approval-card";
import { ClarificationForm } from "../components/ClarificationForm";
import { DecisionTray } from "../components/DecisionTray";
import { PermissionDialog } from "../components/PermissionDialog";
import { PlanApprovalCard } from "../components/PlanApprovalCard";
import type { ClarificationFormData } from "../core/llm/agentic-loop";
import type { PermissionRequest } from "../core/permission/permission";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

function recorder(): {
  outcomes: Array<{ id: string; outcome: DecisionOutcome }>;
  onResolve: (id: string, outcome: DecisionOutcome) => void;
} {
  const outcomes: Array<{ id: string; outcome: DecisionOutcome }> = [];
  return { outcomes, onResolve: (id, outcome) => outcomes.push({ id, outcome }) };
}

const BASH_APPROVAL: ApprovalDecisionRequest = {
  kind: "approval",
  id: "ap1",
  tool: "bash",
  summary: "执行命令: echo hi",
  detail: "echo hi",
};

describe("AU：审批只有一份实现", () => {
  it("AU-1 手机审批：命令可见 → 「批准」只发一个 allow 出口；不支持的能力不出现", () => {
    const { outcomes, onResolve } = recorder();
    render(
      <ApprovalCard
        request={toApprovalDecision({
          approvalId: "ap1",
          tool: "bash",
          summary: "执行命令：echo hi",
          details: { command: "echo hi" },
        })}
        capabilities={{ alwaysAllow: false, rejectReason: false }}
        onResolve={onResolve}
      />,
    );

    const card = document.querySelector('.decision-tray[data-decision-id="ap1"]');
    expect(card, "审批卡没渲染成共享卡").not.toBeNull();
    expect(card!.textContent).toContain("bash");
    expect(card!.textContent).toContain("执行命令：echo hi");
    expect(screen.getByText("echo hi")).toBeTruthy();

    // 能力位 false ⇒ 控件根本不出现（不是 disabled）
    expect(screen.queryByText("始终允许")).toBeNull();
    expect(document.querySelector(".decision-tray-reject-input")).toBeNull();

    fireEvent.click(screen.getByText("批准"));
    expect(outcomes).toEqual([{ id: "ap1", outcome: { kind: "allow" } }]);
  });

  it("AU-1b 能力位 true 时「始终允许」才出现，并发出 always-allow（宿主翻这一位就生效）", () => {
    const { outcomes, onResolve } = recorder();
    render(
      <ApprovalCard
        request={BASH_APPROVAL}
        capabilities={{ alwaysAllow: true, rejectReason: false }}
        onResolve={onResolve}
      />,
    );
    expect(document.querySelector(".decision-tray-btn.submit")?.textContent).toContain("始终允许");
    fireEvent.click(screen.getByText("始终允许"));
    expect(outcomes).toEqual([{ id: "ap1", outcome: { kind: "always-allow" } }]);
  });

  it("AU-2 手机 write 审批：以前只读 details.command（等于没内容），现在有结构化明细", () => {
    const request = toApprovalDecision({
      approvalId: "w1",
      tool: "write",
      summary: "写入文件：a.txt",
      details: { path: "a.txt", bytes: 12 },
    });
    expect(request.detail).toContain('"path": "a.txt"');

    render(
      <ApprovalCard
        request={request}
        capabilities={{ alwaysAllow: false, rejectReason: false }}
        onResolve={() => undefined}
      />,
    );
    const detail = document.querySelector(".decision-tray-args pre");
    expect(detail?.textContent).toContain('"bytes": 12');
  });

  it("AU-3 桌面托盘：两步拒绝 —— 先展开理由输入框，再「确认拒绝」带理由提交", () => {
    const { outcomes, onResolve } = recorder();
    render(
      <DecisionTray
        request={BASH_APPROVAL}
        capabilities={{ alwaysAllow: false, rejectReason: true }}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByText("拒绝"));
    const input = document.querySelector(".decision-tray-reject-input") as HTMLInputElement;
    expect(input, "第一次点拒绝必须展开理由输入框").not.toBeNull();
    expect(screen.getByText("确认拒绝")).toBeTruthy();

    fireEvent.change(input, { target: { value: "这条命令会删数据" } });
    fireEvent.click(screen.getByText("确认拒绝"));
    expect(outcomes).toEqual([
      { id: "ap1", outcome: { kind: "deny", reason: "这条命令会删数据" } },
    ]);
  });

  it("AU-4 一张卡：桌面托盘渲染出来的 DOM 与共享卡逐字一致（没有第二层壳）", () => {
    const caps = { alwaysAllow: false, rejectReason: true } as const;
    render(<ApprovalCard request={BASH_APPROVAL} capabilities={caps} onResolve={() => undefined} />);
    const shared = document.querySelector(".decision-tray")!.outerHTML;
    cleanup();

    render(<DecisionTray request={BASH_APPROVAL} capabilities={caps} onResolve={() => undefined} />);
    const desktop = document.querySelector(".decision-tray")!.outerHTML;
    expect(desktop, "桌面托盘必须与共享卡逐字一致（只允许外壳差异）").toBe(shared);
  });

  it("AU-5 桌面权限弹窗：风险分级 + 资源路径 + 来源标注，且没有假的「始终允许」", () => {
    const calls: Array<{ allow: boolean; alwaysAllow?: boolean }> = [];
    const request = {
      id: "perm-1",
      sessionId: "s1",
      tool: "bash",
      input: { command: "sudo rm -rf /tmp/x" },
      resource: "/tmp/x",
      timestamp: 0,
      // App 给远端/委派审批加的来源前缀（`.permission-*` 时代从未显示过）
      title: "[手机发起] bash",
    } as PermissionRequest & { title?: string };

    render(
      <PermissionDialog
        request={request}
        onResolve={(allow, alwaysAllow) => calls.push({ allow, alwaysAllow })}
      />,
    );

    expect(document.querySelector(".permission-overlay .decision-tray"), "卡必须挂在权限遮罩里").not.toBeNull();
    expect(screen.getByText("高风险")).toBeTruthy();
    expect(screen.getByText("[手机发起]")).toBeTruthy();
    expect(screen.getByText("/tmp/x")).toBeTruthy();
    // 这个入口是**后台**（委派 / 远端）审批：不提供「始终允许」——
    // 远端 broker 只有一次性授权（AB-4），后台路径也不替用户做本会话的长期放行决定
    expect(screen.queryByText("始终允许")).toBeNull();

    fireEvent.click(screen.getByText("批准"));
    expect(calls).toEqual([{ allow: true, alwaysAllow: false }]);

    cleanup();
    render(<PermissionDialog request={request} onResolve={(allow, alwaysAllow) => calls.push({ allow, alwaysAllow })} />);
    fireEvent.click(screen.getByText("拒绝"));
    expect(calls[1]).toEqual({ allow: false, alwaysAllow: false });
  });

  it("AU-6 桌面计划审批：批准 / 拒绝（两步 + 反馈文案）", () => {
    const approved: number[] = [];
    const rejected: string[] = [];
    render(
      <PlanApprovalCard
        plan={"1. 读文件\n2. 改文件"}
        onApprove={() => approved.push(1)}
        onReject={(feedback) => rejected.push(feedback)}
      />,
    );
    expect(screen.getByText(/1\. 读文件/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /批准并执行/ }));
    expect(approved.length).toBe(1);
    cleanup();

    render(
      <PlanApprovalCard
        plan={"1. 读文件"}
        onApprove={() => approved.push(1)}
        onReject={(feedback) => rejected.push(feedback)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^拒绝$/ }));
    const box = document.querySelector(".modal-overlay textarea") as HTMLTextAreaElement;
    expect(box, "拒绝要先展开理由输入").not.toBeNull();
    fireEvent.change(box, { target: { value: "顺序反了" } });
    fireEvent.click(screen.getByRole("button", { name: /拒绝计划/ }));
    expect(rejected).toEqual(["顺序反了"]);
  });

  it("AU-7 桌面澄清：单选/多选/文本都能提交，必填未答时提交不可用，取消有出口", () => {
    const radio: ClarificationFormData = {
      formId: "q1",
      question: "选一个方案",
      type: "radio",
      options: ["A", "B"],
      required: true,
    };
    const submitted: Array<Record<string, string | string[]>> = [];
    render(
      <ClarificationForm form={radio} onSubmit={(a) => submitted.push(a)} onCancel={() => undefined} />,
    );
    const submit = screen.getByRole("button", { name: /提交/ }) as HTMLButtonElement;
    expect(submit.disabled, "必填未答时不许点提交（不是点了再弹报错）").toBe(true);
    // 共享卡的澄清分支必须与桌面原来的 DOM **同构**（多包一层 div 会吃掉 flex gap 间距）
    expect([
      ...(document.querySelector(".clarification-form") as HTMLElement).children,
    ].map((child) => child.className)).toEqual([
      "clarification-question",
      "clarification-required",
      "clarification-inputs",
      "clarification-actions",
    ]);

    fireEvent.click(document.querySelector('input[type="radio"][value="A"]') as HTMLInputElement);
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(submitted).toEqual([{ q1: "A" }]);
    cleanup();

    const checkbox: ClarificationFormData = {
      formId: "q2",
      question: "选几个",
      type: "checkbox",
      options: ["X", "Y"],
      required: false,
    };
    const multi: Array<Record<string, string | string[]>> = [];
    render(
      <ClarificationForm form={checkbox} onSubmit={(a) => multi.push(a)} onCancel={() => undefined} />,
    );
    fireEvent.click(document.querySelector('input[type="checkbox"][value="X"]') as HTMLInputElement);
    fireEvent.click(document.querySelector('input[type="checkbox"][value="Y"]') as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /提交/ }));
    expect(multi).toEqual([{ q2: ["X", "Y"] }]);
    cleanup();

    const text: ClarificationFormData = {
      formId: "q3",
      question: "补充说明",
      type: "text",
      required: true,
    };
    const texts: Array<Record<string, string | string[]>> = [];
    render(
      <ClarificationForm form={text} onSubmit={(a) => texts.push(a)} onCancel={() => undefined} />,
    );
    const area = document.querySelector(".clarification-textarea") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "用 B 方案" } });
    fireEvent.click(screen.getByRole("button", { name: /提交/ }));
    expect(texts).toEqual([{ q3: "用 B 方案" }]);
    cleanup();

    let cancelled = 0;
    render(
      <ClarificationForm form={text} onSubmit={() => undefined} onCancel={() => (cancelled += 1)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(cancelled).toBe(1);
  });

  it("AU-8 折叠：手机端也获得折叠（同一份实现，不是开关）", () => {
    render(
      <ApprovalCard
        request={BASH_APPROVAL}
        capabilities={{ alwaysAllow: false, rejectReason: false }}
        onResolve={() => undefined}
      />,
    );
    expect(document.querySelector(".decision-tray-args")).not.toBeNull();
    fireEvent.click(document.querySelector(".decision-tray-toggle") as HTMLButtonElement);
    expect(document.querySelector(".decision-tray-args")).toBeNull();
  });

  it("AU-9 宿主提交中（busy）：动作按钮全部禁用，避免连点发出两个答复", () => {
    render(
      <ApprovalCard
        request={BASH_APPROVAL}
        capabilities={{ alwaysAllow: false, rejectReason: true }}
        busy
        onResolve={() => undefined}
      />,
    );
    const buttons = [...document.querySelectorAll(".decision-tray-actions button")] as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) {
      expect(button.disabled, `「${button.textContent}」在提交中必须禁用`).toBe(true);
    }
  });

  it("AU-10 只有一份实现：桌面四个入口只做映射，旧骨架与旧类名不再出现", () => {
    const tray = read("src/components/DecisionTray.tsx");
    expect(tray).toContain("packages/ui/src/approval-card");
    expect(tray, "托盘不许再自带骨架").not.toContain("decision-tray-header");
    expect(tray).not.toContain("decision-tray-actions");

    const permission = read("src/components/PermissionDialog.tsx");
    expect(permission).toContain("packages/ui/src/approval-card");
    expect(permission, "权限弹窗的卡片本体已删").not.toContain('className="permission-dialog"');
    expect(permission).not.toContain("permission-btn");

    const plan = read("src/components/PlanApprovalCard.tsx");
    expect(plan).toContain("packages/ui/src/approval-card");
    expect(plan, "计划全文的内联样式已搬进共享卡").not.toContain("whiteSpace");

    const clarification = read("src/components/ClarificationForm.tsx");
    expect(clarification).toContain("packages/ui/src/approval-card");
    expect(clarification, "单选/多选骨架已搬进共享卡").not.toContain("radio-group");

    // 手机侧：组件目录里不再有第二张审批卡
    const components = read("packages/ui/src/components.tsx");
    expect(components).not.toContain('className="approval"');
    expect(components, "ApprovalItem 仍然对外可用（兼容）").toContain("export type { ApprovalItem }");

    // 死的 clarification 入口（`onClarify={() => {}}`）必须消失
    expect(read("src/App.tsx")).not.toContain("onClarify={() => {}}");

    // 共享卡里没有平台开关
    const shared = read("packages/ui/src/approval-card.tsx");
    expect(shared).not.toMatch(/isMobile|isDesktop|placement|platformName/);
  });

  it("AU-11 定位属于外壳：权限遮罩把托盘的 fixed 定位收回，卡片自己不带定位", () => {
    const css = read("src/styles/codem-ui.css");
    expect(css, "遮罩内必须把卡收回行内流（否则卡飘到遮罩右下）").toContain(".permission-overlay .decision-tray");
    expect(css).toMatch(/\.permission-overlay \.decision-tray\s*\{[\s\S]*?position:\s*static/);

    const shared = read("packages/ui/src/approval-card.tsx");
    expect(shared, "卡片自己不许写定位/遮罩").not.toMatch(/position:\s*"(fixed|absolute)"/);
    expect(shared).not.toContain("createPortal");
  });
});
