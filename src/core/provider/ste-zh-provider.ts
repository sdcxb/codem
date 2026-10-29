/**
 * @codem/ste-zh provider — 只暴露启停状态与 prompt 段。
 *
 * 该插件是 core：始终提供 `steZh` 服务，让界面按钮在关闭时也能重新开启；
 * 真正是否注入规则由设置 `codem-ste-zh-enabled` 决定。
 */
import type { Plugin } from "../cordis/src/index.ts";
import {
  isSteZhEnabled,
  setSteZhEnabled,
  buildSteZhPromptSection,
} from "../ste-zh/index.ts";

export const steZhProvider: Plugin = (ctx: any) => {
  const service = {
    enabled: (): boolean => isSteZhEnabled(),
    setEnabled: (enabled: boolean): void => setSteZhEnabled(enabled),
    section: (): string => buildSteZhPromptSection(),
  };
  return ctx.provide("steZh", service);
};
