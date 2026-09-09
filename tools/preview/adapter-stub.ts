/**
 * 预览用适配层桩 —— 只在视觉预览构建里替换真实的 telemetry-adapter，
 * 避免把宿主模块（sql.js / spill-store 的 node 内建依赖等）拉进浏览器构建。
 */

export function toolToActivity(_tool: string): string {
  return "working";
}

export function computeHealth(): number {
  return 0.8;
}

export async function collectSnapshot(): Promise<never> {
  throw new Error("preview: collectSnapshot 被桩替换");
}

export function collectSnapshotSync(): never {
  throw new Error("preview: collectSnapshotSync 被桩替换");
}

export async function loadDefaultDeps(): Promise<Record<string, never>> {
  return {};
}

export const _resetDefaultDeps = (): void => {};
