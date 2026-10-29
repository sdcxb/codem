/**
 * @codem/ste-zh — 简化技术中文汇报插件（独立可启停）
 *
 * 只影响 Agent 写给用户的汇报文字，不改变代码、注释、commit message、
 * 写入项目的文件。启用状态存设置；插件被禁用时 provider 不提供 `steZh`
 * 服务，主 prompt 不注入任何规则。
 *
 * 规则来源：ASD-STE100 的核心原则 + 本项目对 Agent 汇报的裁剪：
 * 结论先行、状态固定、验证与工作分开、证据可定位、不确定写明。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";

export const STE_ZH_SETTING = "codem-ste-zh-enabled";
export const STE_ZH_CHANGED_EVENT = "codem:ste-zh-changed";

export function isSteZhEnabled(): boolean {
  try {
    return getSettingJSON<boolean>(STE_ZH_SETTING, false) === true;
  } catch {
    return false;
  }
}

export function setSteZhEnabled(enabled: boolean): void {
  setSettingJSON(STE_ZH_SETTING, enabled === true);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(STE_ZH_CHANGED_EVENT, { detail: { enabled } }));
  }
}

/**
 * 注入主 prompt 的规则段。保持短小：这是汇报格式约束，不是知识库，
 * 不应该挤占任务上下文。
 */
export function buildSteZhPromptSection(): string {
  if (!isSteZhEnabled()) return "";
  return `# 汇报规范（STE-ZH，启用中）

以下规则只管你怎么向用户写汇报；不改代码、注释、commit message、写入项目的文件。用户明确指定的输出格式优先。

- 首句先给结论：结果写状态与范围；进度写当前动作；排查写原因或“原因未确认”；请求决定写待决事项。不写“我先……然后……”的过程流水账。
- 工作状态只用：已完成、部分完成、未开始、进行中、阻塞、失败、跳过。验证状态单独写：已验证、未验证、未确认。“已完成”不等于“已验证”。
- 修复效果、运行行为、检查结果必须写：检查方法（完整命令）、结果、覆盖范围。没执行的写“未验证”并写原因；缺证据的写“未确认”并写确认方法。
- 引用代码写 \`路径:行号\`；引用命令写完整命令；不得编造来源里没有的事实。
- 不确定就写“未确认”，不用“可能 / 大概 / 应该是”掩盖。
- 需要用户决定时列编号选项：一个动作 + 后果，推荐项放第一并标“（推荐）”。
- 子智能体向主智能体汇报时用紧凑字段，不要向主智能体列“请用户选择”：
  \`status\` / \`scope\` / \`changed\` / \`verified\` / \`unverified\` / \`evidence\` / \`open\`。
- 短回复不强行套完整模板；只保留有内容的节。没有实际效果的断言时，不要为了格式补“已验证”。`;
}
