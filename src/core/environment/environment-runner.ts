/**
 * Environment Script Runner (ENV Series)
 * 
 * 环境配置功能：
 * - 设置脚本 (setup script): 打开项目时自动执行
 * - 清理脚本 (cleanup script): 切换/关闭项目时执行
 * - 自定义操作 (custom operations): 一键构建/启动/测试等
 */

import { executeCommand } from "../file-api";
import { getSettingJSON } from "../storage/settings";
import type { EnvironmentConfig, CustomOperation } from "../settings/settings";

export interface ScriptRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  duration: number;
}

/**
 * 获取当前环境配置
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  return getSettingJSON<EnvironmentConfig>("codem-env-config", {
    setupScript: undefined,
    cleanupScript: undefined,
    customOperations: [],
  });
}

/**
 * 执行一个脚本命令（带超时保护）
 *
 * timeoutMs 通过 Promise.race 实现：
 * - setup 脚本默认 60s（安装依赖等）
 * - cleanup 脚本默认 30s（应快速完成）
 * - custom 操作默认 300s（构建/测试可能耗时较长）
 *
 * 超时后返回 success=false，避免自动触发的脚本永久阻塞 App.tsx 的 useEffect。
 */
async function runScript(command: string, cwd: string, timeoutMs: number = 60000): Promise<ScriptRunResult> {
  const startTime = Date.now();

  // 用可清理的 timer 避免内存泄漏：Promise.race 结束后必须 clearTimeout
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([
      executeCommand(command, cwd),
      timeoutPromise,
    ]);
    const duration = Date.now() - startTime;
    return {
      success: (result.exitCode ?? 0) === 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.exitCode,
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      stdout: "",
      stderr: error?.message || String(error),
      exitCode: -1,
      duration,
    };
  } finally {
    // 无论成功还是超时，都清理 timer，避免 dangling promise
    if (timerId) clearTimeout(timerId);
  }
}

/**
 * 执行设置脚本（打开项目时自动调用）
 */
export async function runSetupScript(cwd: string): Promise<ScriptRunResult | null> {
  const config = getEnvironmentConfig();
  if (!config.setupScript || !config.setupScript.trim()) {
    return null;
  }

  console.log(`[EnvironmentRunner] Running setup script in ${cwd}: ${config.setupScript}`);
  const result = await runScript(config.setupScript, cwd);

  // Dispatch event so UI can show the result
  window.dispatchEvent(new CustomEvent("codem-env-script-result", {
    detail: {
      type: "setup",
      ...result,
      command: config.setupScript,
      cwd,
    },
  }));

  return result;
}

/**
 * 执行清理脚本（切换/关闭项目时自动调用）
 */
export async function runCleanupScript(cwd: string): Promise<ScriptRunResult | null> {
  const config = getEnvironmentConfig();
  if (!config.cleanupScript || !config.cleanupScript.trim()) {
    return null;
  }

  console.log(`[EnvironmentRunner] Running cleanup script in ${cwd}: ${config.cleanupScript}`);
  const result = await runScript(config.cleanupScript, cwd, 30000);

  window.dispatchEvent(new CustomEvent("codem-env-script-result", {
    detail: {
      type: "cleanup",
      ...result,
      command: config.cleanupScript,
      cwd,
    },
  }));

  return result;
}

/**
 * 执行自定义操作（用户手动触发）
 */
export async function runCustomOperation(operationId: string, cwd: string): Promise<ScriptRunResult | null> {
  const config = getEnvironmentConfig();
  const op = config.customOperations?.find(o => o.id === operationId);
  if (!op) {
    return null;
  }

  console.log(`[EnvironmentRunner] Running custom operation "${op.name}" in ${cwd}: ${op.command}`);
  const result = await runScript(op.command, cwd, 300000); // 5 min for builds/tests

  window.dispatchEvent(new CustomEvent("codem-env-script-result", {
    detail: {
      type: "custom",
      operationName: op.name,
      ...result,
      command: op.command,
      cwd,
    },
  }));

  return result;
}

/**
 * 获取自定义操作列表
 */
export function getCustomOperations(): CustomOperation[] {
  return getEnvironmentConfig().customOperations || [];
}
