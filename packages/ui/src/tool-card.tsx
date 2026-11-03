/**
 * 共享工具卡（第 2 步：桌面与其它宿主共用**同一个**工具行）。
 *
 * 第 2 步之前这里是一张「手机端简化卡」，桌面另有一套胶囊行 (`ToolCallCard`)。
 * 现在唯一实现是**胶囊行**（桌面已上线的形态，DOM/类名逐字保留）：
 * - 共享：变体分类、标题、摘要推导、文件路径、状态点、耗时、点击展开、
 *   通用 IN/OUT 明细（`.tool-io-*`）、diff 文本着色；
 * - 注入：`detail` —— 专用明细（Terminal/Diff/Read/Search/Web 卡片由桌面的
 *   `ToolCallCard` 计算后传进来）；`extras` —— 明细下方的附加区
 *   （`metadata.file_paths` 链接、溢出全文入口，这些需要宿主的文件系统能力）。
 *
 * 没有「桌面形态 / 手机形态」两套卡片：宿主只在**明细内容**上不同。
 */
import { memo, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  FileEdit,
  FileText,
  LoaderCircle,
  Search,
  Sparkles,
  Terminal as TerminalIcon,
  XCircle,
} from "lucide-react";

// ====== 类型定义 ======

/** 工具行变体 — 对标 DSH ToolRowVariant */
export type ToolRowVariant = "search" | "read" | "bash" | "write" | "edit" | "code" | "others";

/** 行状态 — 对标 DSH ToolRowState */
export type ToolRowState = "running" | "ok" | "error" | "stopped";

export type ToolCardStatus = "running" | "done" | "error";

// ====== 变体分类 — 对标 DSH classifyTool ======

const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: "bash",
  pwsh: "bash",
  shell: "bash",
  read: "read",
  cat: "read",
  web_fetch: "read",
  web_search: "search",
  grep: "search",
  glob: "search",
  search_notebook: "search",
  write: "write",
  edit: "edit",
  run_code: "code",
  todowrite: "others",
  create_note: "others",
  edit_note: "others",
  delete_note: "others",
  link_notes: "others",
  load_skill: "others",
  subagent: "others",
  spawn_subagent: "others",
  terminal_open: "bash",
  terminal_send: "bash",
  terminal_read: "bash",
  terminal_signal: "bash",
  terminal_close: "bash",
  terminal_list: "bash",
};

const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: "Search",
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  code: "Code",
  others: "Tool call",
};

const TOOL_TITLES: Record<string, string> = {
  search_notebook: "Search Knowledge",
  web_search: "Web Search",
  web_fetch: "Web Fetch",
  todowrite: "Update Tasks",
  load_skill: "Load Skill",
  spawn_subagent: "Sub-agent",
  subagent: "Sub-agent",
  report: "Agent Report",
  send_message: "Send Message",
  interrupt_agent: "Interrupt Agent",
  list_agents: "List Agents",
  create_note: "Create Note",
  edit_note: "Edit Note",
  delete_note: "Delete Note",
  link_notes: "Link Notes",
};

export function classifyTool(toolName: string): ToolRowVariant {
  const lower = toolName.toLowerCase();
  return TOOL_VARIANTS[lower] ?? "others";
}

/** 行标题：具体工具优先，其次变体 */
export function toolRowTitle(toolName: string, variant: ToolRowVariant): string {
  return TOOL_TITLES[toolName.toLowerCase()] ?? VARIANT_TITLES[variant];
}

/** 变体前导图标 — 对标 DSH VARIANT_ICONS */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  search: <Search size={14} />,
  read: <FileText size={14} />,
  bash: <TerminalIcon size={14} />,
  write: <FileEdit size={14} />,
  edit: <FileEdit size={14} />,
  code: <Code2 size={14} />,
  others: <Sparkles size={14} />,
};

// ====== 摘要推导 — 对标 DSH deriveSummary ======

const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ["description", "command"],
  read: ["path", "file_path", "url"],
  search: ["query", "pattern", "url"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  code: ["description"],
  others: [],
};

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

export function deriveSummary(variant: ToolRowVariant, argsRaw: string, fallback?: string): string {
  if (argsRaw === "") return fallback ?? "";
  try {
    const parsed = JSON.parse(argsRaw);
    if (typeof parsed !== "object" || parsed === null) return firstLine(argsRaw);
    const args = parsed as Record<string, unknown>;
    const picked = pickString(args, SUMMARY_KEYS[variant]);
    if (picked !== undefined) return firstLine(picked);
    // 找第一个字符串值
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v !== "") return firstLine(v);
    }
    return firstLine(argsRaw);
  } catch {
    return firstLine(argsRaw);
  }
}

// ====== 文件路径推导 ======

const FILE_PATH_KEYS = ["path", "file_path"] as const;
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(["read", "write", "edit"]);

export function deriveFilePath(variant: ToolRowVariant, argsRaw: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined;
  try {
    const parsed = JSON.parse(argsRaw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return pickString(parsed as Record<string, unknown>, FILE_PATH_KEYS);
  } catch {
    return undefined;
  }
}

// ====== IN/OUT 卡片体推导 ======

export function deriveBody(variant: ToolRowVariant, argsRaw: string): string | null {
  if (argsRaw === "") return null;
  try {
    const parsed = JSON.parse(argsRaw);
    if (parsed === undefined) return argsRaw;
    if (variant === "code" && typeof parsed === "object" && parsed !== null) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === "string" && code !== "") return code;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return argsRaw;
  }
}

/**
 * bash 的退出码有时只存在于结果文本/metadata 中，tool call 的 status 仍是 done。
 * 只看 status 会把 `exit 1` 画成成功（用户实测：失败工具卡不出现）。
 */
function hasExitFailure(toolResult: string | undefined, metadata: Record<string, any> | undefined): boolean {
  const metaExit = Number(metadata?.exitCode ?? metadata?.exit_code);
  const textExit = /(?:exit(?:\s+with)?\s+(?:code\s*)?[:：]?\s*|退出码\s*[:：]?\s*)([1-9]\d*)/i.exec(toolResult || "")?.[1];
  return (Number.isFinite(metaExit) && metaExit !== 0) || textExit !== undefined;
}

/** 极简统一 diff 高亮：只对 `+` / `-` 行着色，不猜 hunk 语义 */
function DiffText(props: { text: string }) {
  return (
    <pre className="tool-diff">
      {props.text.split("\n").map((line, i) => (
        <div
          key={i}
          className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : undefined}
        >
          {line}
        </div>
      ))}
    </pre>
  );
}

export interface ToolCardViewProps {
  toolName: string;
  /** 参数原文（字符串或已序列化 JSON） */
  toolArgs?: string;
  /** 结果原文 */
  toolResult?: string;
  status: ToolCardStatus;
  duration?: number;
  /** 头部参数摘要（缺省时从 toolArgs 推导） */
  argsSummary?: string;
  /** 结构化元数据（退出码等状态提升用） */
  metadata?: Record<string, any>;
  /** 专用明细（Terminal/Diff/Read/Search/Web）—— 宿主注入；缺省渲染通用 IN/OUT */
  detail?: ReactNode;
  /** 明细下方的附加区（文件路径链接 / 溢出全文入口）—— 宿主注入 */
  extras?: ReactNode;
}

export const ToolCardView = memo(function ToolCardView({
  toolName,
  toolArgs,
  toolResult,
  status,
  duration,
  argsSummary,
  metadata,
  detail,
  extras,
}: ToolCardViewProps) {
  const [expanded, setExpanded] = useState(false);

  const variant = useMemo(() => classifyTool(toolName), [toolName]);
  const title = toolRowTitle(toolName, variant);
  const Icon = VARIANT_ICONS[variant];

  const isRunning = status === "running";
  const isError = status === "error" || hasExitFailure(toolResult, metadata);
  const rowState: ToolRowState = isRunning ? "running" : isError ? "error" : "ok";

  // 摘要：优先用 argsSummary，否则从 args 推导
  const summary = useMemo(() => {
    if (argsSummary) return argsSummary;
    return deriveSummary(variant, toolArgs || "", toolName);
  }, [variant, toolArgs, argsSummary, toolName]);

  // 文件路径
  const filePath = useMemo(() => deriveFilePath(variant, toolArgs || ""), [variant, toolArgs]);

  // IN/OUT body
  const body = useMemo(() => {
    if (filePath) return null; // 单文件工具不展示 args body
    return deriveBody(variant, toolArgs || "");
  }, [variant, toolArgs, filePath]);

  const output = toolResult || null;
  const errorSummary = isError && output ? firstLine(output) : null;

  // 有任何明细材料？
  const expandable = detail != null || body !== null || output !== null || extras != null;
  const open = expanded && expandable;

  // 折叠行摘要：错误行用错误首行
  const collapsedSummary = errorSummary ?? summary;

  // 前导图标：运行/错误时替换为状态指示
  function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
    switch (state) {
      case "error": return <XCircle size={10} className="tool-pill-icon-error" />;
      case "stopped": return <XCircle size={10} className="tool-pill-icon-warning" />;
      default: return icon;
    }
  }

  return (
    <div className="tool-call-card-wrap" data-variant={variant} data-state={rowState} data-tool={toolName}>
      {/* 折叠行 */}
      <div
        className={`tool-call-pill ${isError ? "error" : ""} ${expandable ? "expandable" : ""}`}
        onClick={expandable ? () => setExpanded((e) => !e) : undefined}
        role={expandable ? "button" : undefined}
        aria-expanded={expandable ? open : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={expandable ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); }
        } : undefined}
      >
        {/* 前导图标 + 状态 */}
        <div className="tool-pill-icon-frame">
          {isRunning ? (
            <LoaderCircle size={10} className="tool-pill-icon-spin" />
          ) : (
            leadingFor(rowState, <span className="tool-pill-icon">{Icon}</span>)
          )}
        </div>

        {/* 标题 */}
        <span className="tool-pill-text">
          <span className="tool-pill-title">{title}</span>
          {/* 摘要 */}
          {collapsedSummary && collapsedSummary !== title && (
            <span className="tool-pill-preview"> · {collapsedSummary}</span>
          )}
          {/* 文件路径 */}
          {filePath && (
            <span className="tool-pill-preview tool-pill-file">
              {filePath}
            </span>
          )}
        </span>

        {/* 时长 */}
        {duration !== undefined && duration > 0 && (
          <span className="tool-pill-duration">{(duration / 1000).toFixed(1)}s</span>
        )}

        {/* 展开/折叠指示器 */}
        {expandable && (
          expanded ? <ChevronDown size={12} className="tool-pill-chevron" />
                   : <ChevronRight size={12} className="tool-pill-chevron" />
        )}
      </div>

      {/* 展开体 — 对标 DSH ToolRow bodyWrap */}
      {open && (
        <div className="tool-pill-detail tool-pill-detail--inset">
          {/* 专用明细优先（宿主注入）；否则通用 IN/OUT */}
          {detail != null ? (
            detail
          ) : (
            (body !== null || output !== null) && (
              <div className="tool-io-card">
                {body !== null && (
                  <div className={`tool-io-section ${output !== null ? "tool-io-section--bordered" : ""}`}>
                    <span className="tool-io-label">IN</span>
                    <pre className="tool-io-text">{body}</pre>
                  </div>
                )}
                {output !== null && (
                  isDiffText(output) ? (
                    <DiffText text={output} />
                  ) : (
                    <div className="tool-io-section">
                      <span className="tool-io-label">OUT</span>
                      <pre className="tool-io-text" data-error={isError || undefined}>{output}</pre>
                    </div>
                  )
                )}
              </div>
            )
          )}

          {/* 附加区（文件路径链接 / 溢出全文入口） */}
          {extras}
        </div>
      )}
    </div>
  );
});

/** 结果看起来是 unified diff ⇒ 用增删行着色（原共享工具卡的行为，逐字保留） */
function isDiffText(text: string): boolean {
  return /^diff --git |^@@ |\n\+/.test(text) && /\n-/.test(text);
}
