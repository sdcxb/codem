/**
 * 运行时目录规划 + node 检测/决策（纯函数，便于单测）。
 *
 * 目录布局（appData/.codem/zvec-grep/）：
 *   runtime/node/     portable node（系统 node ≥22 时可为空）
 *   runtime/zg/       zvec-grep 裁剪包（dist/cli/index.js 为 CLI 入口）
 *   models/           ZVEC_GREP_MODEL_CACHE（模型缓存，预置或 zg 自拉）
 *   state/            ZVEC_GREP_HOME（daemon 状态/日志）
 *   install-meta.json 安装元数据
 */

import { ZVEC_REL_DIR } from "./types";

export interface ZvecPaths {
  baseDir: string; // .../.codem/zvec-grep
  nodeDir: string;
  zgDir: string;
  modelsDir: string;
  stateDir: string;
  metaFile: string;
}

/** 由 appData 基础目录（含 .codem 尾缀或平台 dataDir）拼运行时路径 */
export function buildZvecPaths(appDataBase: string): ZvecPaths {
  const sep = appDataBase.includes("/") && !appDataBase.includes("\\") ? "/" : "\\";
  const baseDir = appDataBase.endsWith(sep)
    ? `${appDataBase}${ZVEC_REL_DIR}`
    : `${appDataBase}${sep}${ZVEC_REL_DIR}`;
  return {
    baseDir,
    nodeDir: `${baseDir}${sep}runtime${sep}node`,
    zgDir: `${baseDir}${sep}runtime${sep}zg`,
    modelsDir: `${baseDir}${sep}models`,
    stateDir: `${baseDir}${sep}state`,
    metaFile: `${baseDir}${sep}install-meta.json`,
  };
}

/** zg CLI 入口（解压后应存在 dist/cli/index.js） */
export function zgCliPathOf(zgDir: string): string {
  const sep = zgDir.includes("/") && !zgDir.includes("\\") ? "/" : "\\";
  return `${zgDir}${sep}dist${sep}cli${sep}index.js`;
}

/** 解析 `node -v` 输出为 [major, minor, patch]；非法返回 null */
export function parseNodeVersion(out: string): [number, number, number] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(out.trim());
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** 从 nodejs.org dist index.json 选择最新 LTS 的 win-x64 zip 下载地址 */
export function pickNodeWinZipUrl(indexJson: unknown[]): string | null {
  // index.json: [{ version, lts: false | "代号", ... }] 降序，首个 string lts 即最新 LTS
  for (const row of indexJson) {
    const r = row as { version?: string; lts?: string | boolean };
    if (!r || typeof r.version !== "string") continue;
    if (typeof r.lts !== "string") continue; // 仅 LTS（lts 为代号字符串）
    const v = r.version.replace(/^v/, "");
    if (/^\d+\.\d+\.\d+$/.test(v)) {
      return `https://nodejs.org/dist/${r.version}/node-${v}-win-x64.zip`;
    }
  }
  return null;
}

/**
 * 决策 node 可执行文件：
 * 1) 系统 node ≥ minMajor → 直接用系统 node；
 * 2) portable node（runtime/node 下递归找到的 node.exe）→ 用它；
 * 3) 都没有 → null（需要下载 portable）。
 * @param findPortable 递归查找 portable node.exe 的异步函数（依赖文件系统）
 */
export async function resolveNodeExe(
  detectSystem: () => Promise<{ ok: boolean; version: [number, number, number] | null }>,
  findPortable: () => Promise<string | null>,
  minMajor = 22,
): Promise<{ exe: string | null; via: "system" | "portable" | null; systemVersion: string | null }> {
  const sys = await detectSystem();
  if (sys.ok && sys.version && sys.version[0] >= minMajor) {
    return { exe: "node", via: "system", systemVersion: `v${sys.version.join(".")}` };
  }
  const portable = await findPortable();
  if (portable) {
    return { exe: portable, via: "portable", systemVersion: sys.version ? `v${sys.version.join(".")}` : null };
  }
  return { exe: null, via: null, systemVersion: sys.version ? `v${sys.version.join(".")}` : null };
}
