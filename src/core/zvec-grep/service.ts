/**
 * zvec-grep 运行时编排服务。
 *
 * 职责：在线安装（下载 node/zg/模型 → 解压 → 注册 MCP stdio → 通知重启）、
 * 离线 zip 导入、卸载、状态查询、索引重建（模型升级/切换）。
 *
 * 运行时全部落在 <appData>/.codem/zvec-grep/，不进入主安装包；
 * zg 经 `server --stdio` 由 Rust mcp_stdio_connect 常驻拉起（自动复用 daemon）。
 */

import { downloadFileExt, extractZip, getAppDataBaseDir } from "./artifacts";
import {
  buildZvecPaths,
  zgCliPathOf,
  resolveNodeExe,
  parseNodeVersion,
  pickNodeWinZipUrl,
  type ZvecPaths,
} from "./runtime";
import { exists, executeCommand, listDirectory, deletePath, readFile, writeFile } from "../file-api";
import {
  ZVEC_MCP_SERVER,
  ZVEC_RUNTIME_ZIP_URL,
  ZVEC_MODEL_PACK_URL,
  NODE_INDEX_URL,
  ZVEC_MIN_NODE_MAJOR,
  ZVEC_MODELS,
  ZVEC_EVENT_CHANGED,
  type ZvecRuntimeStatus,
  type ZvecInstallPhase,
} from "./types";
import { getSettingJSON, setSettingJSON } from "../storage/settings";

// ========== 内部工具 ==========

const ps = (p: string): string => p.replace(/'/g, "''");

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent(ZVEC_EVENT_CHANGED));
  } catch { /* 非浏览器环境忽略 */ }
}

/** 系统 node 检测：node -v */
async function detectSystemNode(): Promise<{ ok: boolean; version: [number, number, number] | null }> {
  try {
    const r = await executeCommand("node -v", undefined, 15000);
    const version = parseNodeVersion(r.stdout);
    return { ok: r.exitCode === undefined || r.exitCode === 0, version };
  } catch {
    return { ok: false, version: null };
  }
}

/** 递归查找 portable node.exe（深度限制） */
async function findPortableNode(dir: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  let entries: Array<{ name: string; path: string; isDirectory: boolean }> = [];
  try {
    entries = await listDirectory(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory) {
      if (e.name.toLowerCase() === "node.exe") return e.path;
      continue;
    }
    const found = await findPortableNode(e.path, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 运行 zg CLI（PowerShell 引号安全） */
async function runZgCli(
  nodeExe: string,
  zgCli: string,
  positional: string[],
  flags: string[] = [],
  cwd?: string,
  timeoutMs = 900000,
): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const args = [...flags, ...positional.map((a) => `'${ps(a)}'`)];
  const cmd = `& '${ps(nodeExe)}' '${ps(zgCli)}' ${args.join(" ")}`;
  return executeCommand(cmd, cwd, timeoutMs);
}

/** 是否已注册 MCP（含节点信息一致性校验返回需要 update 的 config） */
function findMcpConfig(): { index: number; needUpdate: boolean; nodeExe?: string } | null {
  const configs = getSettingJSON<Array<Record<string, unknown>>>("codem-mcp-servers", []);
  const idx = configs.findIndex((c) => c.name === ZVEC_MCP_SERVER);
  if (idx < 0) return null;
  return { index: idx, needUpdate: false };
}

// ========== 元数据 ==========

export interface ZvecMeta {
  source: "online" | "zip" | null;
  version: string | null;
  installedAt: string | null;
  nodeVia: "system" | "portable" | null;
}

async function readMeta(paths: ZvecPaths): Promise<ZvecMeta> {
  const empty: ZvecMeta = { source: null, version: null, installedAt: null, nodeVia: null };
  try {
    if (!(await exists(paths.metaFile))) return empty;
    const raw = await readFile(paths.metaFile);
    const parsed = JSON.parse(raw);
    return {
      source: parsed?.source || null,
      version: parsed?.version || null,
      installedAt: parsed?.installedAt || null,
      nodeVia: parsed?.nodeVia || null,
    };
  } catch {
    return empty;
  }
}

async function writeMeta(paths: ZvecPaths, meta: ZvecMeta): Promise<void> {
  await writeFile(paths.metaFile, JSON.stringify(meta, null, 2));
}

// ========== MCP 注册 ==========

async function ensureMcpServer(paths: ZvecPaths, nodeExe: string, zgCli: string): Promise<void> {
  const configs = getSettingJSON<Array<Record<string, unknown>>>("codem-mcp-servers", []);
  const cfg = {
    name: ZVEC_MCP_SERVER,
    transport: "stdio",
    command: nodeExe, // 绝对路径或 "node"（系统 node 走 PATH）
    args: [zgCli, "server", "--stdio", "--mcp-toolset", "agent"],
    env: {
      ZVEC_GREP_HOME: paths.stateDir,
      ZVEC_GREP_MODEL_CACHE: paths.modelsDir,
    },
    autoReconnect: true,
  };
  const idx = configs.findIndex((c) => c.name === ZVEC_MCP_SERVER);
  if (idx >= 0) configs[idx] = cfg;
  else configs.push(cfg);
  setSettingJSON("codem-mcp-servers", configs);

  try {
    const { getMCPRegistry } = await import("../mcp/mcp");
    await getMCPRegistry().connect(cfg as never);
  } catch (e) {
    console.warn("[zvec-grep] MCP connect failed (重启后生效):", e);
  }
}

// ========== 状态查询 ==========

export async function getRuntimeStatus(): Promise<ZvecRuntimeStatus> {
  const base = await getAppDataBaseDir();
  const paths = buildZvecPaths(base);
  const zgCli = zgCliPathOf(paths.zgDir);
  const zgInstalled = await exists(zgCli).catch(() => false);

  const sysNode = await detectSystemNode();
  const sysOk =
    sysNode.ok && sysNode.version !== null && sysNode.version[0] >= ZVEC_MIN_NODE_MAJOR;
  const portable = sysOk ? null : await findPortableNode(paths.nodeDir);
  const nodeReady = sysOk || portable !== null;
  const nodeExe = sysOk ? "node" : portable;

  const meta = await readMeta(paths);

  // 默认模型 best-effort 探测
  let modelReady = false;
  try {
    modelReady = await exists(`${paths.modelsDir}/model2vec/minishlab--potion-code-16M-v2`);
  } catch { modelReady = false; }

  const mcpRegistered = (getSettingJSON<Array<Record<string, unknown>>>("codem-mcp-servers", []))
    .some((c) => c.name === ZVEC_MCP_SERVER);

  const status: ZvecRuntimeStatus = {
    runtimeInstalled: zgInstalled,
    nodeReady,
    nodeExe,
    systemNodeVersion: sysNode.version ? `v${sysNode.version.join(".")}` : null,
    zgCliPath: zgInstalled ? zgCli : null,
    modelReady,
    mcpRegistered,
    source: meta.source,
    version: meta.version,
    installedAt: meta.installedAt,
    label: "",
  };
  status.label = describe(status);
  return status;
}

function describe(s: ZvecRuntimeStatus): string {
  if (!s.runtimeInstalled) return "未安装";
  if (!s.nodeReady) return "运行时已装，缺少 node（需修复）";
  const mcps = s.mcpRegistered ? "MCP 已注册" : "MCP 未注册（重启后生效）";
  const model = s.modelReady ? "默认模型就绪" : "模型待首次建索引时下载";
  return `已安装（${s.source === "zip" ? "离线包" : "在线"}）· ${mcps} · ${model}`;
}

// ========== 安装 ==========

async function ensureRuntimeDirs(paths: ZvecPaths): Promise<void> {
  // 父目录由 downloadFileExt / extractZip 自动创建；这里确保 state 目录存在
  await writeFile(`${paths.stateDir}/.keep`, "").catch(() => {});
}

async function downloadNodeIfNeeded(paths: ZvecPaths, onPhase: PhaseCb): Promise<string> {
  const existing = await findPortableNode(paths.nodeDir);
  if (existing) return existing;
  onPhase("downloading-node", "下载 Node 运行时（约 35MB）...");
  const zipPath = `${paths.baseDir}/.tmp-node.zip`;
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) throw new Error("Tauri runtime not available");
    const res: { status: number; body: string } = await invoke("http_get", {
      url: NODE_INDEX_URL,
      headers: null,
    });
    const index = JSON.parse(res.body);
    const url = pickNodeWinZipUrl(index);
    if (!url) throw new Error("无法解析 Node.js LTS 下载地址");
    onPhase("downloading-node", "下载 Node 运行时...");
    await downloadFileExt(url, zipPath, 1200);
  } catch (e) {
    throw new Error(`下载 Node 失败：${(e as Error).message}`);
  }
  onPhase("extracting-node", "解压 Node 运行时...");
  await extractZip(zipPath, paths.nodeDir);
  const node = await findPortableNode(paths.nodeDir);
  if (!node) throw new Error("Node 解压后未找到 node.exe");
  return node;
}

type PhaseCb = (phase: ZvecInstallPhase, message: string) => void;

/**
 * 在线一键安装：
 * 1) node：优先系统 node ≥22，否则下载 portable；
 * 2) zg 裁剪运行时（release asset）；3) 模型 best-effort；4) 注册 MCP。
 */
export async function installOnline(onPhase: PhaseCb = () => {}): Promise<ZvecRuntimeStatus> {
  const base = await getAppDataBaseDir();
  const paths = buildZvecPaths(base);
  onPhase("checking-node", "检查 Node 环境...");
  await ensureRuntimeDirs(paths);

  const sysNode = await detectSystemNode();
  const useSystem =
    sysNode.ok && sysNode.version !== null && sysNode.version[0] >= ZVEC_MIN_NODE_MAJOR;
  let nodeExe: string;
  if (useSystem) {
    nodeExe = "node";
  } else {
    nodeExe = await downloadNodeIfNeeded(paths, onPhase);
  }

  const zgCli = zgCliPathOf(paths.zgDir);
  if (!(await exists(zgCli).catch(() => false))) {
    onPhase("downloading-runtime", "下载 zvec-grep 运行时（约 150MB）...");
    const zipPath = `${paths.baseDir}/.tmp-zg.zip`;
    await downloadFileExt(ZVEC_RUNTIME_ZIP_URL, zipPath, 1800);
    onPhase("extracting-runtime", "解压运行时...");
    await extractZip(zipPath, paths.zgDir);
  }
  if (!(await exists(zgCli).catch(() => false))) {
    throw new Error("运行时包不完整（缺少 dist/cli/index.js）。请检查下载源。");
  }

  // 模型 best-effort（失败不阻塞：zg 首次建索引时会自行下载）
  try {
    const present = await exists(`${paths.modelsDir}/model2vec/minishlab--potion-code-16M-v2`);
    if (!present) {
      onPhase("downloading-model", "下载默认模型 potion-code-16m-v2（33MB）...");
      const zipPath = `${paths.baseDir}/.tmp-models.zip`;
      await downloadFileExt(ZVEC_MODEL_PACK_URL, zipPath, 1200);
      await extractZip(zipPath, paths.modelsDir);
    }
  } catch (e) {
    console.warn("[zvec-grep] 模型预置失败（建索引时 zg 会自动下载）:", e);
  }

  await writeMeta(paths, {
    source: "online",
    version: "0.2.x",
    installedAt: new Date().toISOString(),
    nodeVia: useSystem ? "system" : "portable",
  });

  onPhase("registering-mcp", "注册 MCP 服务器...");
  await ensureMcpServer(paths, nodeExe, zgCli);
  onPhase("done", "安装完成");
  notify();
  return getRuntimeStatus();
}

/**
 * 离线 zip 导入：包内含 runtime/node、runtime/zg、models/ 与 install-meta.json
 * （发布脚本 codem-zvec-runtime-*.zip 结构）。zip 整体解压到运行时根目录。
 */
export async function installFromZip(zipFilePath: string, onPhase: PhaseCb = () => {}): Promise<ZvecRuntimeStatus> {
  const base = await getAppDataBaseDir();
  const paths = buildZvecPaths(base);
  onPhase("extracting-runtime", "解压离线包...");
  await extractZip(zipFilePath, paths.baseDir);

  const zgCli = zgCliPathOf(paths.zgDir);
  if (!(await exists(zgCli).catch(() => false))) {
    throw new Error("离线包不完整：缺少 zg 运行时（dist/cli/index.js）。");
  }
  const portable = await findPortableNode(paths.nodeDir);
  const sysNode = await detectSystemNode();
  const useSystem =
    sysNode.ok && sysNode.version !== null && sysNode.version[0] >= ZVEC_MIN_NODE_MAJOR;
  const nodeExe = useSystem ? "node" : portable || (await downloadNodeIfNeeded(paths, onPhase));

  const meta = await readMeta(paths);
  await writeMeta(paths, {
    source: "zip",
    version: meta.version || "unknown",
    installedAt: meta.installedAt || new Date().toISOString(),
    nodeVia: useSystem ? "system" : "portable",
  });

  onPhase("registering-mcp", "注册 MCP 服务器...");
  await ensureMcpServer(paths, nodeExe, zgCli);
  onPhase("done", "导入完成");
  notify();
  return getRuntimeStatus();
}

// ========== 卸载 / 索引 ==========

export async function uninstall(): Promise<void> {
  // 1) 断开/移除 MCP
  const configs = getSettingJSON<Array<Record<string, unknown>>>("codem-mcp-servers", []);
  const next = configs.filter((c) => c.name !== ZVEC_MCP_SERVER);
  setSettingJSON("codem-mcp-servers", next);
  try {
    const { getMCPRegistry } = await import("../mcp/mcp");
    getMCPRegistry().removeServer(ZVEC_MCP_SERVER);
  } catch { /* 忽略 */ }

  // 2) 删除运行时目录
  const base = await getAppDataBaseDir();
  const paths = buildZvecPaths(base);
  await deletePath(paths.baseDir).catch(() => {});
  notify();
}

export interface IndexResult {
  ok: boolean;
  output: string;
  error?: string;
}

/**
 * 为项目根重建/新建索引（模型升级/切换）。
 * CLI direct 模式前台执行（不走 MCP full 工具集，避免 agent 静默建索引）。
 */
export async function rebuildIndex(
  root: string,
  modelId = "local/potion-code-16m-v2",
  onPhase: PhaseCb = () => {},
): Promise<IndexResult> {
  const status = await getRuntimeStatus();
  if (!status.nodeExe || !status.zgCliPath) {
    return { ok: false, output: "", error: "zvec-grep 运行时未安装，请先在插件管理安装。" };
  }
  onPhase("done", `正在为 ${root} 建立索引（${modelId}）...`);
  try {
    const r = await runZgCli(
      status.nodeExe,
      status.zgCliPath,
      [root],
      ["index", "--rebuild", "--embedding", modelId, "--mode", "direct"],
      root,
      1800000,
    );
    notify();
    const out = (r.stdout || r.stderr || "").slice(0, 2000);
    return {
      ok: r.exitCode === undefined || r.exitCode === 0,
      output: out,
      error: r.exitCode ? out : undefined,
    };
  } catch (e) {
    return { ok: false, output: "", error: (e as Error).message };
  }
}

/** 已下载模型探测（models 目录 hint 粗查） */
export async function listPresentModels(): Promise<string[]> {
  const base = await getAppDataBaseDir();
  const paths = buildZvecPaths(base);
  const present: string[] = [];
  for (const m of ZVEC_MODELS) {
    const seg = m.dirHint.includes("/") ? m.dirHint : `model2vec/${m.dirHint}`;
    try {
      if (await exists(`${paths.modelsDir}/${seg}`)) present.push(m.id);
    } catch { /* ignore */ }
  }
  return present;
}
