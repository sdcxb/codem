/**
 * 重复工具调用守卫（第 62 波）—— 「把十几分钟的原地打转，压缩成几次就喊停」。
 *
 * 起因是真实事故：用户把长对话交接给一个新会话后，新会话**连续执行了几十次几乎一样的
 * `Get-ChildItem` 目录枚举**（只换 `-Force` / `-LiteralPath` / `Out-String -Width 200` /
 * `Sort-Object` 这些装饰性开关），一直转到父会话等待超时，十几分钟没有任何产出。
 *
 * 为什么既有的两道阀门都拦不住：
 *   ① `AgenticLoop` 的「连续无进展」阀门把 `toolCallsInIteration > 0` 一律算作**有进展**
 *      —— 每次枚举都成功返回了内容，于是计数器每次都被清零，`MAX_CONSECUTIVE_NO_PROGRESS = 30`
 *      永远到不了；
 *   ② 同轮次去重只覆盖 `read`（同 path+range）与 `wait_for_delegation`（同 task_id），
 *      **bash 换个写法就绕过去了**。
 *
 * 因此本模块做两件事，且都做成**纯函数/纯状态机**（可单测、不依赖 AgenticLoop 的 3200 行）：
 *   · 精确指纹：同一工具 + 完全相同的参数，反复调用 → 提醒 → 抑制；
 *   · 意图指纹：**只读目录枚举**类命令按「目标路径」归并（忽略装饰性开关），
 *     在**期间没有任何写操作**的前提下反复枚举同一目标 → 提醒 → 抑制 → 直接停。
 *
 * 关键设计取舍（避免把正常的迭代工作误伤）：
 *   · 任何写操作（write/edit/bash 中的写命令）都会**重置**计数 —— 世界变了，重新枚举是合理的；
 *   · 「停」这一档只对**只读枚举**生效（同一目标、无写入、十次以上），
 *     精确指纹最多到「抑制」，剩下的交给 AgenticLoop 既有的无进展阀门；
 *   · 认不出来的命令一律按「其它」处理（只参与精确指纹），**宁可漏判也不误杀**。
 */

export type GuardAction = "allow" | "warn" | "suppress" | "stop";
export type GuardKind = "exact" | "enumerate";

export interface GuardDecision {
  action: GuardAction;
  kind?: GuardKind;
  /** 归一化后的指纹（日志/事件里用） */
  signature?: string;
  /** 该指纹累计出现次数 */
  count?: number;
  /** 追加到工具结果里的引导语（warn/suppress/stop） */
  message?: string;
}

export interface RepeatGuardLimits {
  /** 精确指纹：第几次开始提醒（仍执行） */
  exactWarn: number;
  /** 精确指纹：第几次开始抑制（不执行，返回引导语） */
  exactSuppress: number;
  /** 只读枚举：第几次开始提醒 */
  enumWarn: number;
  /** 只读枚举：第几次开始抑制 */
  enumSuppress: number;
  /** 只读枚举：第几次直接停下整个循环 */
  enumStop: number;
  /** 文案里怎么称呼当前会话（"子会话" / "本次会话"） */
  label: string;
}

export const DEFAULT_GUARD_LIMITS: RepeatGuardLimits = {
  exactWarn: 3,
  exactSuppress: 5,
  enumWarn: 4,
  enumSuppress: 7,
  enumStop: 10,
  label: "本次会话",
};

// ========== 命令意图识别 ==========

/** 只读「列目录 / 看文件存在与否」类命令（含常见别名） */
const ENUMERATE_CMDS = new Set([
  "get-childitem", "gci", "dir", "ls", "tree",
  "get-item", "gi", "resolve-path", "rvpa", "test-path",
  "list_directory", "find", "fd", "where", "where.exe",
]);

/** 只切换工作目录，不算枚举也不算写入 —— 但它的路径是所有后续枚举的上下文 */
const CD_CMDS = new Set(["cd", "chdir", "set-location", "sl", "pushd", "popd"]);

/** 会改变磁盘状态、或语义上属于「干活」的命令 —— 见到就把枚举计数清零 */
const MUTATE_CMDS = new Set([
  "set-content", "sc", "add-content", "ac", "out-file",
  "new-item", "ni", "mkdir", "md", "rmdir", "rd",
  "remove-item", "ri", "rm", "del", "erase",
  "move-item", "mi", "mv", "move", "copy-item", "cpi", "cp", "copy",
  "rename-item", "rni", "ren", "touch", "tee",
  "git", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "python", "python3",
  "node", "cargo", "rustc", "go", "dotnet", "make", "cmake", "gradle", "mvn",
  "tsc", "vite", "pytest", "jest", "vitest", "docker", "kubectl", "curl", "wget",
  "invoke-webrequest", "iwr", "invoke-restmethod", "start-process", "saps", "start",
]);

/**
 * 归一化路径：统一小写、反斜杠、去掉引号与结尾斜杠。
 * `D:\a\b\` 与 `"d:/a/b"` 视为同一目标 —— 这正是事故里 30 个变体被合并成一个的方式。
 */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^["']|["']$/g, "");
  p = p.replace(/\//g, "\\").replace(/\\+$/, "");
  return p.toLowerCase();
}

/** 取一段命令的首个 token（去掉引号、去掉路径前缀、去掉 .exe） */
function headOf(segment: string): string {
  const raw = segment.trim().split(/\s+/)[0] ?? "";
  return normalizeCmdWord(raw);
}

function normalizeCmdWord(raw: string): string {
  const bare = raw.replace(/^["']|["']$/g, "");
  if (!bare) return "";
  const base = bare.split(/[\\/]/).pop() ?? bare;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * 「语句位置」的命令词。
 *
 * 只看每个 segment 的第一个 token 是不够的 —— 事故里的命令大量是复合形态：
 *   `if (Test-Path "D:\x\y") { Get-ChildItem -Force "D:\x\y" | Select-Object … } else { … }`
 * 这里的 `Get-ChildItem` 跟在 `{` 后面、`Test-Path` 跟在 `(` 后面。
 * 因此按「行首 / ; | & { ( 」这些边界来识别命令位置，而不是按 `|` 切段后取头。
 */
const CMD_WORD_RE = /(?:^|[;|&{(])\s*(?:&\s*)?([A-Za-z][\w.-]*)/g;

/** 命令词之后的片段（到下一个语句边界为止），用来抽路径 */
function fragmentAfter(command: string, from: number): string {
  const rest = command.slice(from);
  const stop = rest.search(/[;|&{}\n]/);
  return stop === -1 ? rest : rest.slice(0, stop);
}

/** 抽出一段命令里的路径字面量 */
function pathsIn(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(/[a-z]:\\[^\s"'|;)]*|\\\\[^\s"'|;)]*|\.[\\/][^\s"'|;)]*/gi)) {
    const p = normalizePath(m[0]);
    if (p && p !== "." && p !== "..") out.push(p);
  }
  return out;
}

/**
 * 解析一条 bash/PowerShell 命令的**意图**。
 *
 * - `mutate`：任一语句位置的命令词是写操作（或整条命令里出现重定向）→ 调用方应重置所有计数；
 * - `enumerate`：含只读枚举命令、且不含写命令 → 返回 `signature`（目标路径集合）；
 * - `other`：认不出来 → 只参与精确指纹（宁可漏判，也不误杀）。
 *
 * cd / Where-Object / Select-Object / Format-* / Sort-Object / Out-String / Test-Path 之外的
 * 未知命令词一律「既不枚举也不写入」，不会污染判定。
 */
export function bashIntent(
  command: string,
  cwd?: string,
): { kind: "enumerate" | "mutate" | "other"; signature?: string } {
  const cmd = command ?? "";
  if (!cmd.trim()) return { kind: "other" };
  if (/(^|\s)>>?(\s|$)/.test(cmd)) return { kind: "mutate" }; // 重定向写出

  const words: Array<{ word: string; fragment: string }> = [];
  CMD_WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CMD_WORD_RE.exec(cmd)) !== null) {
    const word = normalizeCmdWord(m[1]);
    if (!word) continue;
    words.push({ word, fragment: fragmentAfter(cmd, m.index + m[0].length) });
  }
  if (words.length === 0) return { kind: "other" };

  // 写命令优先：只要出现过，就按「世界会变」处理
  if (words.some((w) => MUTATE_CMDS.has(w.word))) return { kind: "mutate" };

  // cd 提供「当前目录」上下文：裸 Get-ChildItem 归到它名下，而不是笼统的 <cwd>
  let cwdHint: string | undefined;
  for (const w of words) {
    if (CD_CMDS.has(w.word)) cwdHint = pathsIn(w.fragment).pop() ?? cwdHint;
  }
  // 会话工作目录兜底：事故里裸 `Get-ChildItem -Force` 与显式写全路径的命令**其实是同一个目标**，
  // 静态分析只有拿到 cwd 才能把它们并成一个指纹（否则少拦一半）。
  const fallback = cwdHint ?? (cwd ? normalizePath(cwd) : "<cwd>");

  const targets = new Set<string>();
  for (const w of words) {
    if (!ENUMERATE_CMDS.has(w.word)) continue;
    const found = pathsIn(w.fragment);
    if (found.length === 0) targets.add(fallback);
    else for (const p of found) targets.add(p);
  }
  if (targets.size === 0) return { kind: "other" };
  return { kind: "enumerate", signature: [...targets].sort().join(" ") };
}

// ========== 精确指纹 ==========

/** 递归排序对象的键，保证 `{a:1,b:2}` 与 `{b:2,a:1}` 得到同一指纹 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** 精确指纹：工具名 + 归一化后的参数（小写、压缩空白） */
export function exactSignature(name: string, input: unknown): string {
  let body: string;
  try {
    body = stableStringify(input ?? {});
  } catch {
    body = String(input);
  }
  const normalized = body.toLowerCase().replace(/\s+/g, " ").trim();
  return `${name}::${normalized.length > 400 ? normalized.slice(0, 400) : normalized}`;
}

/** 这些工具自带更贴切的去重/缓存（readCache、writeCache、wait 结果缓存），不再叠一层 */
const GUARD_EXEMPT_TOOLS = new Set(["wait_for_delegation", "wait_for_subagent", "update_plan", "show_todo"]);

/** 语义上属于「写」的非 bash 工具 —— 见到就重置枚举计数 */
const MUTATING_TOOLS = new Set(["write", "edit", "multi_edit", "patch", "apply_patch", "notebook_create", "notebook_update"]);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ========== 守卫状态机 ==========

export class RepeatGuard {
  private readonly limits: RepeatGuardLimits;
  private exact = new Map<string, number>();
  private enumCounts = new Map<string, number>();
  private exactWarned = new Set<string>();
  private enumWarned = new Set<string>();
  private mutatedSinceEnum = false;
  /** 统计（写进日志/事件，便于排查「为什么停了」） */
  readonly stats = { exactRepeats: 0, enumRepeats: 0, suppressed: 0, stopped: 0, mutations: 0 };

  constructor(limits: Partial<RepeatGuardLimits> = {}) {
    this.limits = { ...DEFAULT_GUARD_LIMITS, ...limits };
  }

  reset(): void {
    this.exact.clear();
    this.enumCounts.clear();
    this.exactWarned.clear();
    this.enumWarned.clear();
    this.mutatedSinceEnum = false;
  }

  /** 写操作发生 —— 世界变了，枚举计数清零（精确指纹保留：同一条命令再跑一次仍是重复） */
  noteMutation(): void {
    this.stats.mutations++;
    this.enumCounts.clear();
    this.enumWarned.clear();
    this.mutatedSinceEnum = true;
  }

  /**
   * 在执行**之前**调用。返回的 `message` 应追加到工具结果里（warn），
   * 或作为替代结果返回（suppress/stop）。
   *
   * `cwd` 用于把「裸枚举命令」（`Get-ChildItem -Force`）归到真实目标路径上。
   */
  inspect(
    name: string,
    input: Record<string, unknown> | undefined,
    ctx: { cwd?: string } = {},
  ): GuardDecision {
    const args = input ?? {};

    if (MUTATING_TOOLS.has(name)) {
      this.noteMutation();
      return { action: "allow" };
    }

    if (name === "bash" || name === "shell" || name === "run_command" || name === "terminal") {
      const command = String((args as any).command ?? (args as any).cmd ?? "");
      const intent = bashIntent(command, ctx.cwd);
      if (intent.kind === "mutate") {
        this.noteMutation();
        return { action: "allow" };
      }
      if (intent.kind === "enumerate" && intent.signature) return this.bumpEnum(intent.signature, command);
    }

    if (GUARD_EXEMPT_TOOLS.has(name)) return { action: "allow" };
    return this.bumpExact(exactSignature(name, args), name);
  }

  private bumpEnum(signature: string, command: string): GuardDecision {
    const n = (this.enumCounts.get(signature) ?? 0) + 1;
    this.enumCounts.set(signature, n);
    if (n > 1) this.stats.enumRepeats++;

    const where = truncate(signature, 160);
    if (n >= this.limits.enumStop) {
      this.stats.stopped++;
      return {
        action: "stop",
        kind: "enumerate",
        signature,
        count: n,
        message:
          `[REPEAT GUARD — STOP] 你已经用不同写法**第 ${n} 次**枚举同一个目标，而且期间没有任何写操作：\n` +
          `  目标: ${where}\n  最近一次命令: ${truncate(command, 200)}\n\n` +
          `反复枚举不会带来新信息（内容没有变化），只会消耗时间和费用。现在停止枚举，改用以下之一：\n` +
          `  1) 用 read 直接读你已经知道的文件；\n` +
          `  2) 如果目标文件确实不存在，**直接报告"未找到 + 你已尝试的路径"**，并把结论交回调用方；\n` +
          `  3) 如果需要调用方补充信息，明确写出你需要什么。\n` +
          `不要再调用任何目录枚举命令。`,
      };
    }
    if (n >= this.limits.enumSuppress) {
      this.stats.suppressed++;
      return {
        action: "suppress",
        kind: "enumerate",
        signature,
        count: n,
        message:
          `[REPEAT GUARD] 目录枚举被跳过：这是第 ${n} 次枚举 ${where}（期间没有任何写操作），` +
          `结果不会变。请改用 read 读具体文件，或直接给出结论 / 报告缺失。`,
      };
    }
    if (n >= this.limits.enumWarn && !this.enumWarned.has(signature)) {
      this.enumWarned.add(signature);
      return {
        action: "warn",
        kind: "enumerate",
        signature,
        count: n,
        message:
          `[SYSTEM REMINDER] 你已经在枚举同一个目标（第 ${n} 次）：${where}。` +
          `如果这里没有你要的文件，**不要继续换写法重试** —— 直接说明缺什么、或改用已知路径 read。`,
      };
    }
    return { action: "allow", kind: "enumerate", signature, count: n };
  }

  private bumpExact(signature: string, name: string): GuardDecision {
    const n = (this.exact.get(signature) ?? 0) + 1;
    this.exact.set(signature, n);
    if (n > 1) this.stats.exactRepeats++;

    if (n >= this.limits.exactSuppress) {
      this.stats.suppressed++;
      return {
        action: "suppress",
        kind: "exact",
        signature,
        count: n,
        message:
          `[REPEAT GUARD] 完全相同的 ${name} 调用被跳过（第 ${n} 次，参数一字不差）。` +
          `重复执行不会得到不同结果：请改用不同参数/不同工具，或直接给出结论。` +
          `如果你在轮询等待，请说明你在等什么，而不是原样重试。`,
      };
    }
    if (n >= this.limits.exactWarn && !this.exactWarned.has(signature)) {
      this.exactWarned.add(signature);
      return {
        action: "warn",
        kind: "exact",
        signature,
        count: n,
        message:
          `[SYSTEM REMINDER] 这是第 ${n} 次完全相同的 ${name} 调用。` +
          `如果结果已经拿到，请直接使用它继续推进；不要原样重试。`,
      };
    }
    return { action: "allow", kind: "exact", signature, count: n };
  }
}
