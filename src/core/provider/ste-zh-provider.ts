/**
 * @codem/ste-zh provider — 只暴露模式、规则段与回复后校验。
 *
 * 该插件是 core：始终提供 `steZh` 服务，让界面按钮在关闭时也能重新开启；
 * 真正是否注入规则由三态设置 `codem-ste-zh-mode` 决定。
 */
import type { Plugin } from "../cordis/src/index.ts";
import {
  buildSteZhPromptSection,
  getSteZhMode,
  setSteZhMode,
  validateSteZhReport,
  type SteZhMode,
  type SteZhTurnContext,
} from "../ste-zh/index.ts";

export const steZhProvider: Plugin = (ctx: any) => {
  const service = {
    mode: (): SteZhMode => getSteZhMode(),
    setMode: (mode: SteZhMode): void => setSteZhMode(mode),
    section: (turn?: SteZhTurnContext): string => buildSteZhPromptSection(turn),
    validate: (text: string, toolCalls: Array<{ tool?: string; args?: unknown }> | undefined) =>
      validateSteZhReport(text, toolCalls),
  };
  return ctx.provide("steZh", service);
};
