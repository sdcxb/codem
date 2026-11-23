/**
 * 工作区内敏感文件的**读侧**策略（第 17 轮）。
 *
 * ## 为什么需要
 *
 * 沙箱只回答「在不在工作区内」；工作区里的 `.env`、`.git/config`、私钥、云凭据
 * 仍然可以被 `read` / `grep` / `bash` / `lsp` / `run_code` 读出来并发给模型。
 * 历史 ACL 里有 .env 黑名单，但它从未被消费；这里把规则接回**真实执行路径**。
 *
 * ## 唯一规则表
 *
 * 分类逻辑只有一份：`packages/host/src/sensitive-paths.ts`（Host 共享工作区已经在用，
 * 有 .env/.envrc、.git 目录、.ssh 目录、私钥扩展名、.npmrc/.pypirc/.netrc、
 * `.aws/.kube/.docker`、`*.tfvars`、`application_default_credentials.json` 等）。
 * 这里**不复制规则**，只做桌面侧需要的事情：
 * 1. 绝对路径 → 工作区相对路径；
 * 2. `.env.example/.sample/.template` 这类模板文件明确放行；
 * 3. 把 verdict 映射成读/写动作；
 * 4. shell 文本的敏感访问识别（cat/Get-Content/git show/重定向…）。
 */
import {
  classifySensitivePath,
  type SensitivePathVerdict,
} from "../../../packages/host/src/sensitive-paths";

export type { SensitivePathVerdict };

/** 模板/示例环境文件：读它不会泄漏真实密钥，明确放行 */
const ENV_TEMPLATE_RE = /(^|\/)\.env\.(example|sample|template|dist|defaults|schema|test)$/i;

/** 反斜杠 → `/`、剥 `\\?\`、剥 ADS（`file.txt:stream`） */
export function normalizeSensitivePath(input: string): string {
  let p = String(input ?? "").trim().replace(/\\/g, "/");
  if (p.startsWith("//?/")) p = p.slice(4);
  if (p.startsWith("//./")) p = p.slice(4);
  p = p.replace(/\/{2,}/g, "/");
  // Windows ADS：`name.txt:stream` / `name.txt:stream:$DATA`（盘符冒号不算）
  if (!/^[A-Za-z]:\//.test(p) && /:[^/]+$/.test(p)) {
    p = p.replace(/:[^/]+$/, "");
  }
  return p;
}

/** 绝对路径在 workspace 下时转成相对；否则保持规范化后的形态（basename 规则仍可用） */
export function toWorkspaceRelative(input: string, workspace?: string): string {
  const p = normalizeSensitivePath(input);
  if (!workspace) return p.replace(/^\/+/, "");
  const root = normalizeSensitivePath(workspace).replace(/\/+$/, "");
  if (!root) return p.replace(/^\/+/, "");
  const lowerP = p.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lowerP === lowerRoot) return "";
  if (lowerP.startsWith(lowerRoot + "/")) return p.slice(root.length + 1);
  return p.replace(/^\/+/, "");
}

/** Windows 备用数据流（ADS）：file.txt:stream / :$DATA —— 默认文件视图看不到，必须按敏感处理 */
function hasAlternateDataStream(input: string): boolean {
  const p = String(input ?? "").replace(/\\/g, "/");
  const start = /^[A-Za-z]:\//.test(p) ? 2 : 0;
  const idx = p.indexOf(":", start);
  if (idx < 0) return false;
  const rest = p.slice(idx + 1);
  return rest.length > 0 && !rest.startsWith("/");
}

/**
 * 判定一个路径是否属于「读侧敏感」。
 *
 * @returns `null` = 普通/模板文件；否则返回 Host 规则表的 verdict
 */
export function classifySensitiveRead(path: string, workspace?: string): SensitivePathVerdict | null {
  if (hasAlternateDataStream(path)) {
    return {
      rule: "credential-file",
      action: "ask",
      label: "备用数据流",
      reason: "Windows 备用数据流可能藏着默认文件视图看不到的内容",
      risk: "high",
    };
  }
  const rel = toWorkspaceRelative(path, workspace);
  const base = rel.split("/").filter(Boolean).pop() ?? "";
  if (ENV_TEMPLATE_RE.test(base) || ENV_TEMPLATE_RE.test(rel)) return null;
  return classifySensitivePath(rel);
}

/** 读侧是否必须停下（ask 或 deny）；模板文件 false */
export function isSensitiveReadPath(path: string, workspace?: string): boolean {
  const v = classifySensitiveRead(path, workspace);
  return Boolean(v && v.action !== "allow");
}

/** 读动作：`ask` / `deny` / `allow` / `null`（普通路径） */
export function sensitiveReadAction(path: string, workspace?: string): "ask" | "deny" | "allow" | null {
  const v = classifySensitiveRead(path, workspace);
  return v ? v.action : null;
}

/**
 * shell 文本里的敏感访问识别。
 *
 * 这是**文本层**判据，不是内核隔离：变量拼接、编码、脚本二次构造都拦不住；
 * 但覆盖模型最常用的直读/直写写法（见 `SHELL_READ_VERBS` / `SHELL_WRITE_VERBS`）。
 */
const SHELL_READ_VERBS = new Set([
  "cat", "type", "get-content", "gc", "head", "tail", "more", "less", "strings",
  "base64", "xxd", "od", "hexdump", "rg", "grep", "select-string", "sls", "awk",
  "sed", "cut", "sort", "uniq", "findstr", "git", "tar", "7z", "zip", "cp", "copy",
  "scp", "curl", "wget", "invoke-webrequest", "iwr", "get-childitem", "dir", "ls",
]);

const SHELL_WRITE_VERBS = new Set([
  "set-content", "out-file", "add-content", "new-item", "tee", "tee-object",
  "cp", "copy", "copy-item", "mv", "move", "move-item", "install", "rsync",
  "truncate", "shred", "sed", "perl", "dd", "git", "rm", "remove-item", "del",
]);

export interface SensitiveShellAccess {
  /** 读到的敏感路径（相对显示） */
  reads: string[];
  /** 写/删的敏感路径 */
  writes: string[];
}

function shellTokens(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function stripQuotes(token: string): string {
  return token.replace(/^['"]|['"]$/g, "").replace(/^@/, "");
}

/**
 * 从一条 shell 命令里找出对敏感文件的读/写。
 *
 * 判定顺序：先找「写目标」（重定向、写动词的操作对象），其余命中读动词的算读。
 * 不认识动词时**不算读**（避免 `echo .env` 这类误报）；写侧对 `>` 目标与写动词保守命中。
 */
export function detectSensitiveShellAccess(
  command: string,
  workspace?: string,
  cwd?: string,
  isSensitiveToken?: (token: string) => boolean,
): SensitiveShellAccess {
  const reads = new Set<string>();
  const writes = new Set<string>();
  if (!command || !command.trim()) return { reads: [], writes: [] };
  const segments = command.split(/\r?\n|;|&&|\|\|/);
  const cwdBase = cwd ?? workspace;
  /** 词法判定或调用方给的规范路径判定（P0：symlink 目标） */
  const sensitive = (token: string): boolean =>
    isSensitiveToken ? isSensitiveToken(token) : isSensitiveReadPath(token, cwdBase);

  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const tokens = shellTokens(seg);

    // 重定向目标：`> .env`、`>> x`、`2> x`
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^(\d?>|>>|1>|2>)$/.test(t) && tokens[i + 1]) {
        const target = stripQuotes(tokens[i + 1]);
        if (sensitive(target)) writes.add(target);
      }
      if (/^>>?/.test(t) && t.length > 1) {
        const target = stripQuotes(t.replace(/^>>?/, ""));
        if (sensitive(target)) writes.add(target);
      }
      if (/^of=/i.test(t)) {
        const target = stripQuotes(t.slice(3));
        if (sensitive(target)) writes.add(target);
      }
    }

    const verb = (tokens[0] ?? "").toLowerCase();
    const verbBase = verb.includes("/") ? verb.split("/").pop()! : verb;

    // 写动词：其后的敏感 token 视为写（`Set-Content .env` / `cp x .env` / `sed -i`）
    if (SHELL_WRITE_VERBS.has(verbBase)) {
      const isGitCheckout = verbBase === "git" && /\b(checkout|restore|clean)\b/i.test(seg);
      for (const token of tokens.slice(1)) {
        const t = stripQuotes(token);
        if (!t || t.startsWith("-")) continue;
        if (sensitive(t)) {
          if (isGitCheckout || /^(set-content|out-file|add-content|new-item|tee|tee-object|cp|copy|copy-item|mv|move|move-item|install|rsync|truncate|shred|rm|remove-item|del|sed|perl|dd)$/i.test(verbBase)) {
            writes.add(t);
          }
        }
      }
      if (/\bsed\b[^|]*\s-i\b/i.test(seg)) {
        for (const token of tokens.slice(1)) {
          const t = stripQuotes(token);
          if (t && sensitive(t)) writes.add(t);
        }
      }
    }

    // 读动词：敏感 token 若不是写目标，算读
    if (SHELL_READ_VERBS.has(verbBase)) {
      for (const token of tokens.slice(1)) {
        const t = stripQuotes(token);
        if (!t || t.startsWith("-") || /^of=/i.test(t)) continue;
        // 正则/转义 token（如 grep 的 \.env）不是路径；UNC（\\\\server）除外
        if (/^\\/.test(t) && !/^\\\\\\\\/.test(t)) continue;
        if (!sensitive(t)) continue;
        if (!writes.has(t)) reads.add(t);
      }
    }

    // `git show HEAD:.env` / `git cat-file -p HEAD:.env`：路径藏在参数里
    if (verbBase === "git" && /\b(show|cat-file|log|diff)\b/i.test(seg)) {
      for (const token of tokens) {
        const t = stripQuotes(token);
        const idx = t.indexOf(":");
        if (idx < 0) continue;
        const candidate = t.slice(idx + 1);
        if (sensitive(candidate)) reads.add(t);
      }
    }
  }

  return { reads: [...reads], writes: [...writes] };
}


﻿/**
 * P0：shell 文本的规范路径版本。
 *
 * 同步检测器只认字面文件名；工作区里 notes.txt -> .env 这种链接会漏。
 * 这里先把 token 批量解析成真实路径，再把「规范路径敏感」反馈给同步检测器；
 * 无法解析（旧构建/测试）时退回词法检测（不是放行）。
 */
export async function detectSensitiveShellAccessCanonical(
  command: string,
  workspace?: string,
  cwd?: string,
): Promise<SensitiveShellAccess> {
  const lexical = detectSensitiveShellAccess(command, workspace, cwd);
  let canonicalize: ((paths: string[], workspace?: string) => Promise<string[]>) | null = null;
  try {
    const api = await import("../file-api");
    if (typeof api.canonicalizePathsForSecurity === "function") canonicalize = api.canonicalizePathsForSecurity;
  } catch {
    /* 无 file-api ⇒ 退回词法结果 */
  }
  if (!canonicalize || !command.trim()) return lexical;

  const cwdBase = cwd ?? workspace;
  const tokens = new Set<string>();
  for (const seg of command.split(/\r?\n|;|&&|\|\|/)) {
    for (const raw of shellTokens(seg)) {
      const t = stripQuotes(raw).replace(/^>>?/, "").replace(/^of=/i, "");
      if (!t || t.startsWith("-") || /^(\d?>|>>|1>|2>|&&|\|\|)$/.test(t)) continue;
      if (/^https?:\/\//i.test(t)) continue;
      if (/^\\/.test(t) && !/^\\\\/.test(t)) continue;
      tokens.add(t);
      const colon = t.indexOf(":");
      if (colon > 0) tokens.add(t.slice(colon + 1));
    }
  }
  const list = [...tokens].slice(0, 500);
  if (list.length === 0) return lexical;
  let canonicalList: string[] = list;
  try {
    canonicalList = await canonicalize(list, cwdBase);
  } catch {
    return lexical;
  }
  const sensitiveTokens = new Set<string>();
  list.forEach((token, i) => {
    const canonical = canonicalList[i] ?? token;
    if (isSensitiveReadPath(token, cwdBase) || isSensitiveReadPath(canonical, cwdBase)) {
      sensitiveTokens.add(token);
      for (const full of tokens) if (full.endsWith(":" + token)) sensitiveTokens.add(full);
    }
  });
  if (sensitiveTokens.size === 0) return lexical;
  return detectSensitiveShellAccess(command, workspace, cwd, (t) => sensitiveTokens.has(t));
}

/** 从 grep 的 `path:line:content` 行里取路径（Windows 盘符冒号不算分隔） */
export function grepLinePath(line: string): string | null {
  const m = /^(.*):(\d+):/.exec(line);
  return m ? m[1] : null;
}

/**
 * 过滤 grep 结果里的敏感文件行。
 *
 * @param allowPath 显式批准读取的敏感文件（用户已审批的那一个）
 */
export function filterSensitiveGrepMatches(
  matches: readonly string[],
  workspace?: string,
  allowPath?: string,
): { matches: string[]; skipped: number } {
  const kept: string[] = [];
  let skipped = 0;
  for (const line of matches) {
    const path = grepLinePath(line);
    if (!path) {
      kept.push(line);
      continue;
    }
    if (allowPath) {
      const relPath = toWorkspaceRelative(path, workspace).toLowerCase();
      const relAllow = toWorkspaceRelative(allowPath, workspace).toLowerCase();
      if (relPath === relAllow || relPath.endsWith("/" + relAllow)) {
        kept.push(line);
        continue;
      }
    }
    if (isSensitiveReadPath(path, workspace)) {
      skipped += 1;
      continue;
    }
    kept.push(line);
  }
  return { matches: kept, skipped };
}

/** 过滤 glob 结果里的敏感文件名（只返回名称也算元数据泄漏） */
export function filterSensitiveGlobFiles(
  files: readonly string[],
  workspace?: string,
): { files: string[]; skipped: number } {
  const kept: string[] = [];
  let skipped = 0;
  for (const f of files) {
    if (isSensitiveReadPath(f, workspace)) skipped += 1;
    else kept.push(f);
  }
  return { files: kept, skipped };
}

/** MCP 资源 URI 是否是「可以按路径判定」的文件形态 */
export function isFileLikeResourceUri(uri: string): boolean {
  const u = String(uri ?? "").trim();
  if (!u) return false;
  if (u.startsWith("file://")) return true;
  // Unix 绝对路径 / Windows 盘符 / UNC
  return u.startsWith("/") || /^[A-Za-z]:[\\/]/.test(u) || u.startsWith("\\\\");
}

/**
 * grep 结果的**真实路径**过滤（P0）。
 *
 * 这里不直接 import file-api（它被 95 个测试 mock，会让本模块变成 mock 依赖）；
 * 运行时动态取 canonicalizePathsForSecurity，取不到（旧构建/测试）就退回词法过滤。
 */
export async function filterSensitiveGrepMatchesCanonical(
  matches: readonly string[],
  workspace?: string,
  allowPath?: string,
): Promise<{ matches: string[]; skipped: number }> {
  let canonicalize: ((paths: string[], workspace?: string) => Promise<string[]>) | null = null;
  try {
    const api = await import("../file-api");
    if (typeof api.canonicalizePathsForSecurity === "function") {
      canonicalize = api.canonicalizePathsForSecurity;
    }
  } catch {
    /* 没有 file-api（测试/旧构建）⇒ 词法过滤 */
  }
  if (!canonicalize) return filterSensitiveGrepMatches(matches, workspace, allowPath);

  const paths = Array.from(new Set(matches.map((line) => grepLinePath(line)).filter((p): p is string => Boolean(p))));
  const canonicalList = await canonicalize(paths, workspace);
  const canonicalByPath = new Map(paths.map((p, i) => [p.toLowerCase(), canonicalList[i] ?? p]));
  const allowRel = allowPath ? toWorkspaceRelative(allowPath, workspace).toLowerCase() : "";
  const kept: string[] = [];
  let skipped = 0;
  for (const line of matches) {
    const path = grepLinePath(line);
    if (!path) { kept.push(line); continue; }
    const canonical = canonicalByPath.get(path.toLowerCase()) ?? path;
    const relCanonical = toWorkspaceRelative(canonical, workspace).toLowerCase();
    const allowed = Boolean(allowRel && (relCanonical === allowRel || relCanonical.endsWith("/" + allowRel)));
    if (!allowed && (isSensitiveReadPath(canonical, workspace) || isSensitiveReadPath(path, workspace))) {
      skipped += 1;
      continue;
    }
    kept.push(line);
  }
  return { matches: kept, skipped };
}
