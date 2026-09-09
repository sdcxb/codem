/**
 * zvec-grep（zg）语义检索运行时常量、模型清单与状态类型。
 *
 * 设计原则：运行时（node + 裁剪 zg + 可选模型）全部落在
 * <appData>/.codem/zvec-grep/ 下，不进入主安装包；入口经插件市场
 * 一键安装（在线编排）或离线 zip 导入；zg 以 MCP stdio 模式接入
 * 现有 MCPRegistry（zg server --stdio 会自动起/复用后台 daemon）。
 */

/** 运行时根目录名（相对 appData/.codem） */
export const ZVEC_REL_DIR = "zvec-grep";

/** MCP 服务器名（tools/list 会暴露 zvec_grep_search 等工具） */
export const ZVEC_MCP_SERVER = "zvec_grep";

/** 元数据文件（记录安装来源/版本/时间/所选 node） */
export const ZVEC_META_FILE = "install-meta.json";

/** zg 最低 node 版本 */
export const ZVEC_MIN_NODE_MAJOR = 22;

/**
 * 发布物 URL（在线编排下载源；未来随 release 产出对应 asset）。
 * 开发/测试可用环境变量覆盖：ZVEC_GREP_RUNTIME_URL / ZVEC_GREP_MODEL_PACK_URL。
 */
export const ZVEC_RELEASE_BASE =
  process.env.ZVEC_GREP_RELEASE_BASE ||
  "https://github.com/sdcxb/codem/releases/download/v1.11.0";

/** 裁剪后的 zg 运行时包（含 dist + 精简 node_modules） */
export const ZVEC_RUNTIME_ZIP_URL =
  process.env.ZVEC_GREP_RUNTIME_URL || `${ZVEC_RELEASE_BASE}/codem-zvec-runtime-win-x64.zip`;

/** 模型缓存预置包（HF 目录结构，来自发布脚本打包） */
export const ZVEC_MODEL_PACK_URL =
  process.env.ZVEC_GREP_MODEL_PACK_URL ||
  `${ZVEC_RELEASE_BASE}/codem-zvec-models-potion-code16.zip`;

/** nodejs.org 版本索引（解析最新 LTS 的下载地址） */
export const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";

/** 可切换的 embedding 模型目录（v1 显示用；下载走 zg 自身/模型包） */
export interface ZvecModelInfo {
  id: string;
  label: string;
  desc: string;
  /** 推理后端（展示用） */
  runtime: "model2vec" | "onnx" | "llama-cpp" | "remote";
  /** 模型目录名（~cache 下，用于已装检测） */
  dirHint: string;
}

export const ZVEC_MODELS: ZvecModelInfo[] = [
  {
    id: "local/potion-code-16m-v2",
    label: "potion-code-16m-v2",
    desc: "代码向 · Model2Vec · ~33MB · 默认（快，标识符/英文好）",
    runtime: "model2vec",
    dirHint: "minishlab--potion-code-16M-v2",
  },
  {
    id: "local/multilingual-e5-small",
    label: "multilingual-e5-small",
    desc: "多语言(含中文) · ONNX · ~120MB · 中文注释/文档更好",
    runtime: "onnx",
    dirHint: "intfloat--multilingual-e5-small",
  },
  {
    id: "local/potion-multilingual-128m",
    label: "potion-multilingual-128m",
    desc: "101 语言 · Model2Vec · ~531MB · 中文最佳（体积大）",
    runtime: "model2vec",
    dirHint: "minishlab--potion-multilingual-128M",
  },
  {
    id: "local/jina-embeddings-v2-base-code",
    label: "jina-embeddings-v2-base-code",
    desc: "代码向长上下文 8k · ONNX · 质量高（较重）",
    runtime: "onnx",
    dirHint: "jinaai--jina-embeddings-v2-base-code",
  },
];

/** 运行状态（供市场卡片/设置分区展示） */
export interface ZvecRuntimeStatus {
  /** 是否已安装运行时（zg dist 存在） */
  runtimeInstalled: boolean;
  /** node 是否可用（系统 node≥22 或 portable node 就位） */
  nodeReady: boolean;
  /** 实际将使用的 node 可执行文件路径 */
  nodeExe: string | null;
  /** 系统 node 版本（检测到才非空） */
  systemNodeVersion: string | null;
  /** zg CLI 入口（dist/cli/index.js 绝对路径） */
  zgCliPath: string | null;
  /** 默认模型是否已就位（best-effort 探测） */
  modelReady: boolean;
  /** MCP 服务器是否已注册（codem-mcp-servers 含 zvec_grep） */
  mcpRegistered: boolean;
  /** 安装来源：'online' | 'zip' | null */
  source: "online" | "zip" | null;
  /** 安装版本（meta） */
  version: string | null;
  /** 最近一次安装时间（ISO） */
  installedAt: string | null;
  /** 聚合文案（UI 直接可用） */
  label: string;
}

/** 安装阶段（进度文案） */
export type ZvecInstallPhase =
  | "idle"
  | "checking-node"
  | "downloading-node"
  | "extracting-node"
  | "downloading-runtime"
  | "extracting-runtime"
  | "downloading-model"
  | "registering-mcp"
  | "done"
  | "error";

/** 编排服务事件名（UI 订阅刷新） */
export const ZVEC_EVENT_CHANGED = "codem:zvec-status-changed";
