/**
 * Host 侧工具集（Spike 范围：**只读两件** `read` / `glob`）。
 *
 * ## 定位（别误解成"Host 只有两个工具"）
 *
 * 终态里工具**全部**住在 Host；本文件只实现两个只读工具，是为了让 Spike 能
 * 真的跑完一轮"模型 → 工具 → 结果 → 收尾"，从而证明件数不是架构问题。
 * 写/命令/终端/附件这些**有副作用**的工具要连带审批、快照、沙箱一起迁移，
 * 属于阶段 1 的主体工作（清单见 ADR-0001 §5）。
 *
 * ## 为什么 id 与渲染侧一致（`read` / `glob`）
 *
 * 工具的 id 会进模型请求、进 JSONL 的 `toolCalls`、进 UI 的工具卡。两边不一致
 * 会让"同一段历史在桌面与手机上显示成两个工具"。判据方向：`host-tool-parity`
 * 断言 Host 注册的工具 id 是渲染侧 id 集合的子集（阶段 1 升级成"逐个 schema 相等"）。
 *
 * ## 安全边界
 *
 * 所有路径**先 resolve 再判断是否在项目根内**，且拒绝符号链接逃逸（`realpath` 后再判）。
 * 这条不能靠"调用方不会传 `..`"—— 手机端是**不可信输入源**。
 */

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ToolContext, ToolDef, ToolExecuteResult } from "../../../src/core/llm/tools";
import {
  collectSensitiveGrepFiles,
  editWorkspaceFile,
  grepWorkspace,
  writeWorkspaceFile,
  type ApproveFn,
} from "./file-ops";
import {
  buildSensitiveReadDetails,
  buildSensitiveReadSummary,
  classifySensitivePath,
  isSensitiveReadPath,
} from "./sensitive-paths";
import { ToolRegistry } from "../../../src/core/llm/tools";
import { HostError } from "./errors";

/** 单次 read 的字符上限（与渲染侧 `read` 的 50KB 口径同量级） */
const READ_MAX_CHARS = 60_000;
const READ_MAX_LINES = 2_000;
const GLOB_MAX_RESULTS = 500;

/**
 * 把客户端给的相对路径解析成项目根内的绝对路径。
 *
 * 拒绝：绝对路径、`..` 逃逸、符号链接指向根外。**返回的路径已经过 realpath**，
 * 后续 IO 直接用返回值（而不是重新拼一次，避免 TOCTOU 的第二处解析）。
 */
export async function resolveInsideRoot(root: string, requested: string): Promise<string> {
  if (!requested || typeof requested !== "string") {
    throw new HostError("INVALID_PARAMS", "path 不能为空");
  }
  if (isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested)) {
    throw new HostError("INVALID_PARAMS", "path 必须是相对项目根的路径（不接受绝对路径）", {
      hint: "客户端不应知道 PC 的盘符",
    });
  }
  const rootReal = await realpath(root).catch(() => resolve(root));
  const candidate = resolve(rootReal, requested);
  const rel = relative(rootReal, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new HostError("INVALID_PARAMS", `path 逃出项目根：${requested}`);
  }
  const real = await realpath(candidate).catch(() => candidate);
  const relReal = relative(rootReal, real);
  if (relReal.startsWith("..") || isAbsolute(relReal)) {
    throw new HostError("INVALID_PARAMS", `path 经符号链接逃出项目根：${requested}`);
  }
  return real;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * 工作区相对路径（realpath 之后计算）。
 *
 * 为什么不直接用客户端给的字符串：`resolveInsideRoot` 已经 realpath 过，
 * 一个叫 `notes.txt` 的符号链接可能真的指向 `.env` —— 判定必须看**真正被打开的那个文件**。
 */
async function workspaceRelative(root: string, abs: string): Promise<string> {
  const rootReal = await realpath(root).catch(() => resolve(root));
  return toPosix(relative(rootReal, abs));
}

/**
 * 共享桌面工作区下的敏感读取审批（工具侧）。
 *
 * 复用写审批同一条通道（`runtime.requestApproval` → `approval.requested` → 客户端答复），
 * 不引入第二套审批机制。只有 `workspaceSharedWithDesktop === true` 时 runtime 才会传它。
 */
export interface SensitiveReadHooks {
  approve: ApproveFn;
}

function rejectedReadMessage(rel: string, note?: string): string {
  return (
    `未读取敏感文件 ${rel}（用户拒绝${note ? `：${note}` : ""}）。` +
    "不要重试，也不要换 offset/pattern 试探；请让用户直接在对话里提供需要的内容。"
  );
}

export function createReadTool(root: string, sensitive?: SensitiveReadHooks): ToolDef {
  return {
    id: "read",
    description: "Read a UTF-8 text file inside the workspace. Use offset/limit for large files.",
    /*
     * 契约声明（第 270 波）：不声明时 `resolveToolContract` 会兜底成
     * `sideEffectScope: "workspace"` ⇒ 每个只读工具都被算成"改动工作区"，
     * 每迭代白拍一次 git 快照。这里与渲染侧 `read` 的契约对齐。
     */
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        offset: { type: "number", description: "1-based first line" },
        limit: { type: "number", description: "Maximum number of lines" },
        line_numbers: { type: "boolean", description: "Prefix each line with its 1-based number" },
      },
      required: ["path"],
    },
    maxResultSizeChars: Infinity,
    async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const requested = String(args.path ?? "");
      const offset = Math.max(1, Number(args.offset ?? 1) || 1);
      const limit = Math.min(READ_MAX_LINES, Math.max(1, Number(args.limit ?? READ_MAX_LINES) || READ_MAX_LINES));
      const withNumbers = args.line_numbers === true;
      const abs = await resolveInsideRoot(root, requested);
      /*
       * 敏感读取的审批必须发生在 `stat`/`readFile` **之前**：
       * 用户拒绝时一个字节都不读（否则"拒绝"只是不显示，内容已经进过 Host 进程）。
       */
      if (sensitive) {
        const rel = await workspaceRelative(root, abs);
        const verdict = classifySensitivePath(rel);
        if (verdict) {
          if (verdict.action === "deny") {
            return {
              title: `read ${requested}`,
              output: `拒绝读取应用内部产物 ${rel}（${verdict.reason}）。它不是项目内容，请改读项目文件。`,
              isError: true,
            };
          }
          if (verdict.action === "ask") {
            const decision = await sensitive.approve({
              tool: "read",
              summary: buildSensitiveReadSummary(rel, verdict),
              details: buildSensitiveReadDetails(rel, verdict, {
                offset,
                limit,
                lineNumbers: withNumbers,
              }),
            });
            if (!decision.allowed) {
              return {
                title: `read ${requested}`,
                output: rejectedReadMessage(rel, decision.note),
                isError: true,
              };
            }
          }
        }
      }
      const info = await stat(abs);
      if (!info.isFile()) {
        return { title: `read ${requested}`, output: `Error: 不是普通文件：${requested}`, isError: true };
      }
      const raw = await readFile(abs, "utf8");
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // BOM 剥掉（与渲染侧一致）
      const allLines = text.split(/\r?\n/);
      const slice = allLines.slice(offset - 1, offset - 1 + limit);
      const numbered = withNumbers
        ? slice.map((line, i) => `${offset + i}: ${line}`).join("\n")
        : slice.join("\n");
      const truncated = numbered.length > READ_MAX_CHARS;
      const body = truncated ? `${numbered.slice(0, READ_MAX_CHARS)}\n…（已截断）` : numbered;
      return {
        title: `read ${requested}`,
        output: body,
        isError: false,
      };
    },
  };
}

export function createGlobTool(root: string): ToolDef {
  return {
    id: "glob",
    description: "List files under the workspace matching a simple glob (supports * and **).",
    contract: { readOnly: true, accessScope: "workspace" },
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to the workspace, e.g. src/**/*.ts" },
        limit: { type: "number", description: "Maximum results (default 200)" },
      },
      required: ["pattern"],
    },
    async execute(args, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const pattern = String(args.pattern ?? "");
      const limit = Math.min(GLOB_MAX_RESULTS, Math.max(1, Number(args.limit ?? 200) || 200));
      // 只用 "**" 与 "*" 两种语义，手写转换（不引依赖：Host 要能塞进 APK 的小体积）
      const base = pattern.includes("/") ? pattern.slice(0, pattern.lastIndexOf("/")) : "";
      const start = await resolveInsideRoot(root, base || ".");
      const regex = globToRegExp(pattern);
      const hits: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        if (hits.length >= limit) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= limit) return;
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            const rel = toPosix(relative(root, full));
            if (regex.test(rel)) hits.push(rel);
          }
        }
      };
      await walk(start);
      hits.sort();
      return {
        title: `glob ${pattern}`,
        output: hits.length ? hits.join("\n") : "（没有匹配文件）",
        isError: false,
      };
    },
  };
}

/** `**` → 跨目录、`*` → 段内任意、`?` → 单字符；其余字符转义 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern).replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (normalized[i + 1] === "/") i += 1; // `**/` 匹配零层或多层
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}

/** Host 侧的写/命令执行器（由 runtime 注入：负责审批、超时、进程树与输出上限） */
export type HostBashRunner = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolExecuteResult>;

export interface HostToolHooks {
  bash?: HostBashRunner;
  /** 写操作审批（write/edit）；不提供时**不注册**写工具（只读模式） */
  approve?: ApproveFn;
  /**
   * 共享桌面工作区：read/grep 命中敏感路径时先审批（与写审批同一个 `approve`）。
   *
   * 单独一个布尔位（而不是"有 approve 就开"）：写审批在只读模式下也可能存在，
   * 而读取审批只应由 `workspaceSharedWithDesktop` 打开 —— 两个事实不能混。
   */
  sensitiveRead?: boolean;
}

/** 组装 Host 的工具注册表（阶段 1 会换成"从 packages/agent 统一注册"） */
export function createHostToolRegistry(root: string, opts: HostToolHooks = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const sensitiveRead =
    opts.sensitiveRead === true && opts.approve ? { approve: opts.approve } : undefined;
  registry.register(createReadTool(root, sensitiveRead));
  registry.register(createGlobTool(root));
  if (opts.approve) {
    const approve = opts.approve;
    registry.register({
      id: "grep",
      description: "在工作区里按正则检索文本，返回 path:line:text（只读）。",
      contract: { readOnly: true, accessScope: "workspace" },
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正则（大小写不敏感）" },
          glob: { type: "string", description: "可选的文件名通配（如 *.ts）" },
          max_results: { type: "number", description: "最多返回条数，默认 200" },
        },
        required: ["pattern"],
      },
      async execute(args): Promise<ToolExecuteResult> {
        const pattern = String(args.pattern ?? "");
        /**
         * 共享工作区：先**只读列出**本次会检索到的敏感文件，再一次性问用户。
         *
         * 为什么是"一次审批覆盖本次调用"而不是逐文件问：一次 grep 可能命中几个 `.env`，
         * 逐文件弹卡会把用户淹没，最后必然是"一路允许"。一次调用一个决定，拒绝则整批跳过。
         */
        let allowed: Set<string> | null = null;
        let listTruncated = false;
        if (sensitiveRead) {
          const found = await collectSensitiveGrepFiles({ root, isSensitive: isSensitiveReadPath });
          listTruncated = found.truncated;
          if (found.files.length > 0) {
            const verdicts = found.files
              .map((file) => ({ file, verdict: classifySensitivePath(file) }))
              .filter((x) => x.verdict && x.verdict.action === "ask");
            if (verdicts.length > 0) {
              const labels = [...new Set(verdicts.map((x) => x.verdict!.label))].join("、");
              const decision = await sensitiveRead.approve({
                tool: "grep",
                summary:
                  `检索时读取 ${verdicts.length} 个敏感文件（${labels}）` +
                  (found.truncated ? "（还有更多未列出）" : "") +
                  " —— 批准后内容将发送给模型",
                details: {
                  pattern,
                  files: verdicts.slice(0, 3).map((x) => x.file),
                  fileCount: verdicts.length,
                  truncated: found.truncated,
                  rules: [...new Set(verdicts.map((x) => x.verdict!.rule))],
                  scope: "shared-desktop-workspace",
                  notice:
                    "批准后这些文件里与 pattern 匹配的文本会发送给模型（及模型服务商）；" +
                    "拒绝则整个敏感文件集合都不会被检索。",
                },
              });
              if (decision.allowed) allowed = new Set(verdicts.map((x) => x.file));
            }
          }
        }
        const result = await grepWorkspace({
          root,
          pattern,
          ...(args.glob ? { glob: String(args.glob) } : {}),
          ...(args.max_results ? { maxResults: Number(args.max_results) } : {}),
          ...(sensitiveRead
            ? { skipPath: (rel: string) => isSensitiveReadPath(rel) && !allowed?.has(rel) }
            : {}),
        });
        let body = result.matches.length
          ? result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") + (result.truncated ? "\n（已截断）" : "")
          : "（没有匹配）";
        if (result.skippedSensitive > 0) {
          body +=
            `\n（已跳过 ${result.skippedSensitive} 个敏感文件：未获批准` +
            (listTruncated ? "；敏感文件过多，清单未列全" : "") +
            "）";
        }
        return { title: `grep ${pattern}`, output: body, isError: false };
      },
    });
    registry.register({
      id: "write",
      description: "写入（覆盖）工作区内的一个文件；会先请求用户审批。",
      contract: { sideEffectScope: "workspace", accessScope: "workspace" },
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区的路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path", "content"],
      },
      async execute(args): Promise<ToolExecuteResult> {
        const r = await writeWorkspaceFile({
          root,
          path: String(args.path ?? ""),
          content: String(args.content ?? ""),
          approve,
        });
        return { title: `write ${String(args.path ?? "")}`, output: r.output, isError: r.isError };
      },
    });
    registry.register({
      id: "edit",
      description: "把工作区文件里**唯一**的一处 old_string 替换成 new_string；会先请求用户审批。",
      contract: { sideEffectScope: "workspace", accessScope: "workspace" },
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区的路径" },
          old_string: { type: "string", description: "要被替换的原文（必须唯一）" },
          new_string: { type: "string", description: "替换后的文本" },
        },
        required: ["path", "old_string", "new_string"],
      },
      async execute(args): Promise<ToolExecuteResult> {
        const r = await editWorkspaceFile({
          root,
          path: String(args.path ?? ""),
          oldText: String(args.old_string ?? ""),
          newText: String(args.new_string ?? ""),
          approve,
        });
        return { title: `edit ${String(args.path ?? "")}`, output: r.output, isError: r.isError };
      },
    });
  }
  if (opts.bash) {
    const run = opts.bash;
    registry.register({
      id: "bash",
      description:
        "在工作区执行一条命令（会先请求用户审批）。用于跑测试、构建、查看版本等；不要用它读文件（用 read）。",
      /*
       * `system` 不是"随便改"：`tool-contract.ts::mayMutateWorkspaceViaShell` 会按
       * **命令意图**再判一次（`npx tsc --noEmit` 这类验证命令不算改动）。
       * 声明成 `workspace` 反而会让每条只读命令都触发快照（比桌面更贵、也更吵）。
       */
      contract: { sideEffectScope: "system", accessScope: "system" },
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令（非交互）" },
          cwd: { type: "string", description: "相对工作区的目录（默认工作区根）" },
          timeout_ms: { type: "number", description: "超时毫秒，默认 60000，上限 300000" },
        },
        required: ["command"],
      },
      execute: (args, ctx) => run(args, ctx),
    });
  }
  return registry;
}
