/**
 * `@codem/shell-ops` 的 Cordis 服务提供者（**用 Codem 自己的插件机制**）。
 *
 * ## 为什么是这个形状
 *
 * Codem 的插件机制（对标 DSH）：插件在 `builtin-registry.ts` 里以
 * `registerBuiltinPlugin(name, meta, () => provider)` 注册，provider 是
 * `Plugin = (ctx) => ctx.provide('<服务名>', <服务对象>)`；消费方通过
 * `getToolContext()?.get('<服务名>')` 取用（`tools.ts` 已有这条通道）。
 *
 * 所以这里**不发明任何新机制**：本文件就是把 shell 路由判定暴露成 `shellOps` 服务，
 * 供执行层（`bash` 工具 / `file-api.ts`）按既有方式消费。
 *
 * ## 独立性（用户要求）
 *
 * 本插件全部代码在 `src/plugins/shell-ops/`；把 `builtin-registry.ts` 里那一行注册去掉，
 * 服务即消失、消费方自动回到旧行为（Windows PowerShell）—— 这就是"完全独立、可启停、可删除"。
 */

import type { Plugin } from "../../core/cordis/src/index.ts";
import { describeShellOps, isShellOpsEnabled, resolveShellPlan, type ShellPlan } from "./policy";

/**
 * 服务名。
 *
 * ⚠️ **不 export**（2026-10-16 导出面收口）：消费方是 `core/llm/tools.ts` 的
 * `getToolContext()?.get("shellOps")` —— 那里必须写**字面量**（core 不许 import 插件，
 * 删掉插件目录后 core 仍要能编译）⇒ 导出一个没人 import 的常量只会让人以为
 * "改这里就能换服务名"，是假的单一来源。判据从行为上钉：真装配后 `ctx.get("shellOps")` 必须拿得到（SO-7）。
 */
const SHELL_OPS_SERVICE = "shellOps";

/** 服务对象形状。 */
interface ShellOpsService {
  /** 插件是否启用（默认开）。 */
  isEnabled(): boolean;
  /** 决定这条命令用哪个执行器；返回值里有 `refusal` 时必须拒绝执行。 */
  plan(command: string): ShellPlan;
  /** 一行状态（面板/诊断）。 */
  describe(): string;
}

/**
 * 服务实现。
 *
 * 注意：判定**每次调用都现算**（读设置、读环境变量），这样插件启停与设置改动
 * 立即生效，不需要重启 —— 与 Codem 插件管理器"切换后当前进程立即生效"的语义一致。
 */
function createShellOpsService(): ShellOpsService {
  return {
    isEnabled: () => isShellOpsEnabled(),
    plan: (command: string) => resolveShellPlan(command),
    describe: () => describeShellOps(),
  };
}

/** Cordis 插件：把服务提供出去（`provides: ["shellOps"]`）。 */
export const shellOpsProvider: Plugin = (ctx: any) => {
  /**
   * ⚠️ **装配时这里不写设置**（2026-10-16 真机取证后改的）。
   *
   * 原实现在这里落默认值（`codem-shell-ops-enabled`），而装配发生在存储端口预热之前，
   * 那一笔写**必失败**：真机 console 每次启动都有
   * `[PersistFailure] settings.setSetting 写盘失败 … 端口已注册但该域镜像未接手`，
   * 键因此**永远不存在**（"插件确实跑过"在设置面上没有任何证据）。
   *
   * 现在落默认值的地方是 `policy.ts::resolveShellPlan()` 的第一句 —— 那是
   * "真的要用这个插件"的时刻，应用早就完成预热，而且用的是**确认式写入**
   * （写成功/没写成功分得开）。服务本身仍然在这里 provide：apply 的职责就是提供它。
   */
  const service = createShellOpsService();
  console.log(`[shell-ops] ${service.describe()}`);
  return ctx.provide(SHELL_OPS_SERVICE, service);
};
