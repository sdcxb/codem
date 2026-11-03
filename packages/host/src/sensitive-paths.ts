/**
 * 敏感路径判定（**唯一来源**，纯函数）。
 *
 * ## 为什么需要它
 *
 * Host 的 `read` / `grep` / `workspace.read` / `workspace.diff` 都能读到共享桌面工作区里的
 * `.env`、`.git/config`、`.ssh/**`、私钥/凭据文件。只读不等于无害：这些文件的内容会进模型上下文
 * （再发给模型服务商），所以它们是"读取"这条路径上唯一真正需要用户拍板的东西。
 *
 * ## 为什么是纯函数 + 单一规则表
 *
 * 规则如果分别写在工具、RPC、UI 三处，必然漂移：一处加了 `.env.local`、另一处还只认 `.env`，
 * 症状是"同一个文件在文件浏览器里弹卡、在 chat 里直接读出来"。所以这里只导出**判定**，
 * 调用方只负责"命中后怎么问/怎么拒"。
 *
 * ## 边界（不要夸大）
 *
 * 判定只看**工作区相对路径**。真正的越界（绝对路径、`..`、符号链接逃逸）在进入本模块之前
 * 已经由 `resolveInsideRoot` 拒绝；本模块不承担沙箱职责。
 *
 * ## 门控
 *
 * 本模块**不判断**是否启用审批。启用条件只有一个事实：`workspaceSharedWithDesktop === true`
 * （桌面 Rust 传 `--workspace-shared`）。Android 本机 Host / 开发机手跑都没有这个边界。
 */

/** 规则 ID：**稳定**，UI/日志/判据都按它分支（不要改名，改了就换 ID） */
export type SensitiveRuleId =
  | "env"
  | "git-meta"
  | "ssh-key"
  | "key-material"
  | "credential-file"
  | "app-internal"
  | "app-attachment";

export type SensitiveAction = "ask" | "deny" | "allow";
export type SensitiveRisk = "high" | "medium" | "low";

export interface SensitivePathVerdict {
  rule: SensitiveRuleId;
  /** `ask` = 需要用户批准；`deny` = 直接拒绝（不弹卡）；`allow` = 明确放行 */
  action: SensitiveAction;
  /** 给人看的类别（审批卡标题里用） */
  label: string;
  /** 为什么敏感（审批卡正文用；不要写文件内容） */
  reason: string;
  risk: SensitiveRisk;
}

interface RuleMeta {
  label: string;
  reason: string;
  risk: SensitiveRisk;
}

/**
 * 规则文案表。
 *
 * 放在同一个对象里而不是散在各分支：判据 `SP-6` 直接对它断言"规则 ID/文案稳定"，
 * 这样改一句文案时会先看到判据在盯它（UI 快照/截图用例也依赖这些字符串）。
 */
export const SENSITIVE_RULES: Record<SensitiveRuleId, RuleMeta> = {
  env: {
    label: "环境变量文件",
    reason: "可能包含 API Key、数据库口令等凭据",
    risk: "high",
  },
  "git-meta": {
    label: "Git 元数据",
    reason: "可能包含远程地址里的令牌、credential helper 或 hook 脚本",
    risk: "high",
  },
  "ssh-key": {
    label: "SSH 私钥",
    reason: "私钥泄露可直接登录对应主机",
    risk: "high",
  },
  "key-material": {
    label: "私钥/证书/钥匙串",
    reason: "私钥、证书或钥匙串材料",
    risk: "high",
  },
  "credential-file": {
    label: "凭据文件",
    reason: "云服务或包管理器凭据",
    risk: "high",
  },
  "app-internal": {
    label: "应用内部产物",
    reason: "由 Codem 自动生成的快照/工具结果，不属于项目内容",
    risk: "medium",
  },
  "app-attachment": {
    label: "用户上传的附件",
    reason: "用户在本轮上传、模型需要读取的文件",
    risk: "low",
  },
};

/** 应用内部目录：读取一律拒绝（不弹卡），且 Host 不应再往共享工作区里写它们 */
export const APP_INTERNAL_DIRS = [".codem-snapshots", ".codem-tool-results"] as const;
/** 用户附件目录：模型必须能读，明确放行 */
export const APP_ATTACHMENT_DIR = ".codem-attachments";

/**
 * 把客户端给的路径归一成"工作区相对路径"：
 * - 反斜杠 → `/`；
 * - 去掉开头的 `./` 与多余斜杠；
 * - **不**做 `..` 折叠（那是 `resolveInsideRoot` 的职责；到这里还带 `..` 说明上游漏了）；
 * - 大小写**保持原样**（调用方比对时再小写，避免把显示路径改掉）。
 */
export function normalizeWorkspacePath(input: string): string {
  let p = String(input ?? "").trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/{2,}/g, "/");
  if (p === "." || p === "/") return "";
  return p.replace(/^\/+/, "");
}

function fileNameOf(rel: string): string {
  const p = rel.endsWith("/") ? rel.slice(0, -1) : rel;
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 路径里是否出现连续的这些段（任意深度，大小写不敏感） */
function hasSegmentSequence(segments: string[], parts: string[]): boolean {
  if (parts.length === 0 || segments.length < parts.length) return false;
  const lowerParts = parts.map((p) => p.toLowerCase());
  for (let i = 0; i <= segments.length - lowerParts.length; i++) {
    let hit = true;
    for (let j = 0; j < lowerParts.length; j++) {
      if (segments[i + j] !== lowerParts[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

const ENV_BASENAMES = new Set([".env", ".envrc"]);
const SSH_PRIVATE_KEY_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk",
  "id_ed25519_sk",
]);
const KEY_MATERIAL_EXTS = new Set(["pem", "key", "p12", "pfx", "ppk", "jks", "keystore", "asc", "gpg", "kdbx"]);
const CREDENTIAL_BASENAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".gitconfig",
  "credentials.json",
  "application_default_credentials.json",
]);
const CREDENTIAL_PATH_SEQUENCES: string[][] = [
  [".docker", "config.json"],
  [".aws", "credentials"],
  [".aws", "config"],
  [".kube", "config"],
  [".config", "gh", "hosts.yml"],
];

function extensionOf(base: string): string {
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function verdict(rule: SensitiveRuleId, action: SensitiveAction): SensitivePathVerdict {
  const meta = SENSITIVE_RULES[rule];
  return { rule, action, label: meta.label, reason: meta.reason, risk: meta.risk };
}

/**
 * 判定一个**工作区相对路径**。
 *
 * 返回 `null` = 普通路径（零审批）。同一路径只返回一条规则：顺序即优先级
 * （应用目录 > 环境变量 > git > SSH > 私钥 > 凭据），这样"附件目录里的 `.env`"
 * 不会被判成敏感（它是用户自己上传的，模型必须能读）。
 */
export function classifySensitivePath(input: string): SensitivePathVerdict | null {
  const rel = normalizeWorkspacePath(input);
  if (!rel) return null;
  const lowered = rel.toLowerCase();
  const segments = lowered.split("/").filter(Boolean);
  const first = segments[0];
  const base = fileNameOf(lowered);

  if (first === APP_ATTACHMENT_DIR) return verdict("app-attachment", "allow");
  if ((APP_INTERNAL_DIRS as readonly string[]).includes(first)) return verdict("app-internal", "deny");

  // 环境变量：`.env` / `.env.*` / `*.env` / `.envrc`（`.environment.ts` 不命中）
  if (ENV_BASENAMES.has(base) || base.startsWith(".env.") || base.endsWith(".env")) {
    return verdict("env", "ask");
  }

  // `.git` 整目录：`.git/config`、`.git/credentials`、`.git/hooks/*` 都在里面
  if (segments.includes(".git")) return verdict("git-meta", "ask");

  // `.ssh/**` 与常见私钥文件名（`*.pub` 是公钥，不算私钥）
  if (segments.includes(".ssh")) return verdict("ssh-key", "ask");
  if (SSH_PRIVATE_KEY_BASENAMES.has(base) && !base.endsWith(".pub")) return verdict("ssh-key", "ask");

  if (KEY_MATERIAL_EXTS.has(extensionOf(base))) return verdict("key-material", "ask");

  if (CREDENTIAL_BASENAMES.has(base)) return verdict("credential-file", "ask");
  if (CREDENTIAL_PATH_SEQUENCES.some((seq) => hasSegmentSequence(segments, seq))) {
    return verdict("credential-file", "ask");
  }
  if (segments.includes(".config") && hasSegmentSequence(segments, [".config", "gcloud"])) {
    return verdict("credential-file", "ask");
  }
  if (base.startsWith("service-account") && base.endsWith(".json")) {
    return verdict("credential-file", "ask");
  }
  const ext = extensionOf(base);
  if (ext === "tfvars" || ext === "tfstate") return verdict("credential-file", "ask");

  return null;
}

/** 读取需要审批/明确拒绝的路径（`allow` 的应用附件不算敏感） */
export function isSensitiveReadPath(input: string): boolean {
  const v = classifySensitivePath(input);
  return Boolean(v && v.action !== "allow");
}

/** 审批卡上的"批准后会发生什么"（工具与 RPC 共用同一句，避免两边措辞漂移） */
export const SENSITIVE_READ_NOTICE =
  "批准后文件内容会发送给模型（及模型服务商）；拒绝则不会读取任何字节。";

export function buildSensitiveReadSummary(rel: string, v: SensitivePathVerdict): string {
  return `读取敏感文件 ${rel}（${v.label}）—— 批准后内容将发送给模型`;
}

/**
 * 审批/拒绝详情。**不含正文、不含密钥前缀、不含绝对路径**。
 *
 * `scope` 是给客户端显示"这是共享桌面工作区"：同一句"读取文件"在 Android 本机
 * 是另一回事，用户要能看出边界。
 */
export function buildSensitiveReadDetails(
  rel: string,
  v: SensitivePathVerdict,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path: rel,
    rule: v.rule,
    label: v.label,
    reason: v.reason,
    risk: v.risk,
    scope: "shared-desktop-workspace",
    notice: SENSITIVE_READ_NOTICE,
    ...extra,
  };
}
