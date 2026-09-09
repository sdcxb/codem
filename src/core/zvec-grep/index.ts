/**
 * zvec-grep（zg）语义检索运行时服务 —— 模块出口。
 *
 * 集成形态（不改架构）：运行时以独立目录安装（在线编排或离线 zip），
 * zg 以 MCP stdio 接入现有 MCPRegistry；工具 zvec_grep_search 经现有
 * MCP 桥进入工具运行时，与内置 grep（精确轨）双轨并行。
 */

export * from "./types";
export {
  getRuntimeStatus,
  installOnline,
  installFromZip,
  uninstall,
  rebuildIndex,
  listPresentModels,
  type IndexResult,
  type ZvecMeta,
} from "./service";
export { buildZvecPaths, zgCliPathOf, resolveNodeExe, parseNodeVersion, pickNodeWinZipUrl } from "./runtime";
export { downloadFileExt, extractZip, getAppDataBaseDir } from "./artifacts";
