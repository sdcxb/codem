/**
 * @codem/ste-zh — 简化技术中文汇报插件（独立可启停）
 *
 * 只影响 Agent 写给用户的汇报文字，不改变代码、注释、commit message、
 * 写入项目的文件。插件被禁用时 provider 不提供 `steZh` 服务，主 prompt
 * 不注入任何规则。
 *
 * 2026-10-29 评估后改为三态：
 * - off：不注入；
 * - smart：按回合结构自动选 minimal / full / subagent；
 * - full：始终完整规则。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";

export const STE_ZH_MODE_SETTING = "codem-ste-zh-mode";
const STE_ZH_LEGACY_ENABLED_SETTING = "codem-ste-zh-enabled";
export const STE_ZH_CHANGED_EVENT = "codem:ste-zh-changed";

export type SteZhMode = "off" | "smart" | "full";
type SteZhAppliedMode = "off" | "minimal" | "full" | "subagent";

export interface SteZhTurnContext {
  /** 用户本轮消息；主 agent 用来判断短任务/汇报意图 */
  userMessage?: string;
  /** 子智能体向主智能体汇报 */
  isSubagent?: boolean;
}

interface SteZhFinding {
  code: "verified-without-command";
  message: string;
}

const MODES: readonly SteZhMode[] = ["off", "smart", "full"];

export function getSteZhMode(): SteZhMode {
  try {
    const raw = getSettingJSON<unknown>(STE_ZH_MODE_SETTING, null);
    if (typeof raw === "string" && (MODES as readonly string[]).includes(raw)) {
      return raw as SteZhMode;
    }
    // 兼容旧版布尔开关：true 视为 smart
    const legacy = getSettingJSON<unknown>(STE_ZH_LEGACY_ENABLED_SETTING, false);
    return legacy === true ? "smart" : "off";
  } catch {
    return "off";
  }
}

export function setSteZhMode(mode: SteZhMode): void {
  const next: SteZhMode = MODES.includes(mode) ? mode : "off";
  setSettingJSON(STE_ZH_MODE_SETTING, next);
  // 兼容旧消费者：保留布尔键，但以 mode 为准
  setSettingJSON(STE_ZH_LEGACY_ENABLED_SETTING, next !== "off");
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(STE_ZH_CHANGED_EVENT, { detail: { mode: next } }));
  }
}

export function cycleSteZhMode(mode: SteZhMode): SteZhMode {
  if (mode === "off") return "smart";
  if (mode === "smart") return "full";
  return "off";
}

/**
 * 三态策略：
 * - 子 agent 永远走 subagent（主 agent 需要可解析字段）；
 * - 用户明确要“简短/一句话”或普通短请求且没有汇报意图 → minimal；
 * - 明确要汇报/总结/排查/决定，或请求较长 → full。
 *
 * 注意：这里不猜“任务会不会产生验证”，因为 prompt 在工具执行前构造。
 * “已验证但没有命令”的假声明由 validateSteZhReport 在回复后拦。
 */
function resolveSteZhAppliedMode(ctx: SteZhTurnContext = {}): SteZhAppliedMode {
  const mode = getSteZhMode();
  if (mode === "off") return "off";
  if (ctx.isSubagent) return "subagent";
  if (mode === "full") return "full";
  const msg = (ctx.userMessage || "").trim();
  if (!msg) return "full";
  if (/(简短|简要|一句话|只回复|短一点|不要展开)/.test(msg)) return "minimal";
  const wantsReport = /(汇报|总结|报告|排查|结论|决定|验收|复盘)/.test(msg);
  if (wantsReport) return "full";
  // 普通短请求：不套完整模板；长请求按完整规则
  return msg.length <= 120 ? "minimal" : "full";
}

const MINIMAL_RULES = `# 汇报规范（STE-ZH 精简）

只约束汇报文字，不改代码/注释/commit/文件。用户指定格式优先。

- 第一句必须以状态词开头，格式如「已完成：<范围>」；状态词只用：已完成 / 部分完成 / 未开始 / 进行中 / 阻塞 / 失败 / 跳过。
- 最多 3 句：只写状态、验证结果、未验证项；不写背景、计划、根因分析。
- “已完成”不等于“已验证”。没有执行的检查写“未验证”并写原因；缺证据写“未确认”并写确认方法。
- 引用代码写 \`路径:行号\`；没有来源的事实不要补。`;

const FULL_RULES = `# 汇报规范（STE-ZH，启用中）

以下规则只管你怎么向用户写汇报；不改代码、注释、commit message、写入项目的文件。用户明确指定的输出格式优先。

- 第一句先给结论：结果必须以状态词开头并写范围；进度写当前动作；排查写原因或“原因未确认”；请求决定写待决事项。不写“我先……然后……”的过程流水账。
- 工作状态只用：已完成、部分完成、未开始、进行中、阻塞、失败、跳过。验证状态单独写：已验证、未验证、未确认。“已完成”不等于“已验证”。
- 修复效果、运行行为、检查结果必须写：检查方法（完整命令）、结果、覆盖范围。没执行的写“未验证”并写原因；缺证据的写“未确认”并写确认方法。
- 引用代码写 \`路径:行号\`；引用命令写完整命令；不得编造来源里没有的事实。
- 不确定就写“未确认”，不用“可能 / 大概 / 应该是”掩盖。
- 需要用户决定时列编号选项：一个动作 + 后果，推荐项放第一并标“（推荐）”。
- 子智能体向主智能体汇报时用紧凑字段，不要向主智能体列“请用户选择”：
  \`status\` / \`scope\` / \`changed\` / \`verified\` / \`unverified\` / \`evidence\` / \`open\`。
- 短回复不强行套完整模板；只保留有内容的节。没有实际效果的断言时，不要为了格式补“已验证”。`;

const SUBAGENT_RULES = `# 子智能体汇报字段

完成前**必须调用 \`report\` 工具**，不要只在最终文本里写字段；runtime 只接收 report 的结构化结果。

参数：
- \`status\`: success / partial / failed / blocked / unknown
- \`summary\`: 一句话结论（<=300 字）
- \`changed\`: 改动文件数组；只读任务写空数组
- \`verified\`: 数组，每项 \`{ command, ok, source, evidence? }\`；\`source=agent\` 表示本 agent 实际跑过，调用方给的结果只能写 \`source=caller\`
- \`unverified\`: 没执行的检查及原因
- \`open\`: 需要主智能体决定或补做的事

硬规则：\`verified\` 只写本 agent 实际跑过的命令；调用方给的结果不能写成 \`source=agent\`。`;

export function buildSteZhPromptSection(ctx: SteZhTurnContext = {}): string {
  switch (resolveSteZhAppliedMode(ctx)) {
    case "minimal":
      return MINIMAL_RULES;
    case "full":
      return FULL_RULES;
    case "subagent":
      return SUBAGENT_RULES;
    default:
      return "";
  }
}

const VERIFICATION_CMD =
  /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|\b(?:tsc|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i;

/**
 * 回复后轻量校验：只报“已验证但没有本轮命令证据”，不改写正文。
 * 这是 warn，不是硬门禁；主 agent 仍应抽查命令是否真的跑过。
 */
export function validateSteZhReport(
  text: string,
  toolCalls: Array<{ tool?: string; args?: unknown; status?: string }> | undefined,
): SteZhFinding[] {
  if (getSteZhMode() === "off" || !text) return [];
  const claimsVerified = /(已验证|verified\s*[:：]\s*(?:已验证|verified|true))/i.test(text);
  if (!claimsVerified) return [];
  const hasVerificationCommand = (toolCalls || []).some((tc) => {
    if (tc.status === "error") return false;
    const tool = String(tc.tool || "").toLowerCase();
    if (!["bash", "pwsh", "shell", "terminal_send"].includes(tool)) return false;
    const args = (tc.args || {}) as Record<string, unknown>;
    const command = String(args.command ?? args.input ?? args.cmd ?? "");
    return VERIFICATION_CMD.test(command);
  });
  if (hasVerificationCommand) return [];
  return [
    {
      code: "verified-without-command",
      message:
        "这条回复声称“已验证”，但本轮没有执行测试/构建/类型检查类命令。请核对证据；如果结果来自调用方，应写“调用方提供”，否则改为“未验证/未确认”。",
    },
  ];
}
