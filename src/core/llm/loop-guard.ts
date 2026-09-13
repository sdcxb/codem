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
export type GuardKind = "no-gain" | "no-gain-signature" | "enumerate";

export interface GuardDecision {
  action: GuardAction;
  kind?: GuardKind;
  /** 归一化后的指纹（日志/事件里用） */
  signature?: string;
  /** 触发时的计数：零增益档是「连续零增益次数」，枚举档是「第几次查看同一目标」 */
  count?: number;
  /** 追加到工具结果里的引导语（warn/suppress/stop） */
  message?: string;
}

export interface RepeatGuardLimits {
  /**
   * **零信息增益**重复到第几次开始提醒（仍执行）。
   *
   * 这里的"次数"不是"调用了几次"，而是「**连续拿到已经见过的完全相同的内容、且期间没有任何写操作**」
   * 的次数 —— 也就是**可证明的零进展**。第 64 波之前用的是「同一目标枚举到第 10 次就停」，
   * 那是拿次数当可靠性：合法的反复查看（列目录 → 读 → 再列）会被误杀，而"换十几种写法拿到同一份内容"
   * 反而要数到 10 次才停。现在判据换成信息增益，次数只是去抖。
   */
  noGainWarn: number;
  /** 零信息增益重复到第几次开始跳过（**只跳过那一个签名**，换新手段照常放行） */
  noGainSuppress: number;
  /** 零信息增益重复到第几次直接停下整个循环 */
  noGainStop: number;
  /**
   * 只读枚举的"提醒"阈值（**仅提醒，不再拦**）。
   * 保留它是因为文案里有价值（"你在反复看同一个目录"），但**不作为可靠性机制**。
   */
  enumAdvisoryAt: number;
  /** 文案里怎么称呼当前会话（"子会话" / "本次会话"） */
  label: string;
}

export const DEFAULT_GUARD_LIMITS: RepeatGuardLimits = {
  noGainWarn: 2,
  noGainSuppress: 4,
  noGainStop: 6,
  enumAdvisoryAt: 4,
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

/**
 * 精确指纹：工具名 + 归一化后的参数。
 *
 * 两个刻意的取舍（都是审计时改的）：
 *   · **只压缩空白，不转小写**：小写合并会在**大小写敏感**的文件系统（Linux/macOS）上
 *     把 `Read a.txt` 与 `Read A.txt` 当成同一个调用 —— 那会**误拦一次合法读取**。
 *     少拦一次重复的代价远小于拦错一次；大小写差异交给「枚举意图指纹」去合并（那里只影响循环判定）。
 *   · **不截断**：早先截到 400 字符是为了日志好看，代价是两条长命令只要前 400 字符相同就会被
 *     误判成同一次调用（超长命令恰恰是自动生成的那种）。现在键保留全文，只在文案里截断。
 */
export function exactSignature(name: string, input: unknown): string {
  let body: string;
  try {
    body = stableStringify(input ?? {});
  } catch {
    body = String(input);
  }
  const normalized = body.replace(/\s+/g, " ").trim();
  return `${name}::${normalized}`;
}

/**
 * 这些工具自带更贴切的去重/缓存，不再叠一层守卫：
 *   · `wait_for_delegation` —— 结果缓存 + 单任务查看上限（agentic-loop 里单独处理）；
 *   · `read` / `read_file` / `write` —— readCache / writeCache **会把原内容或原文回给模型**
 *     （"这就是你之前读到的内容，直接用"），比守卫那句"调用被跳过"有用得多；
 *     而且"整轮全是缓存命中"本身就会被循环当成空转，进而走到停止判定。
 * 守卫的位置在读取缓存之前（被拦下的调用不该产生快照等副作用），所以这里必须显式豁免，
 * 否则守卫会把更友好的缓存回复抢先顶掉。
 */
const GUARD_EXEMPT_TOOLS = new Set([
  "wait_for_delegation",
  "wait_for_subagent",
  "read",
  "read_file",
  "write",
  "update_plan",
  "show_todo",
]);

/** 语义上属于「写」的非 bash 工具 —— 见到就重置枚举计数 */
const MUTATING_TOOLS = new Set(["write", "edit", "multi_edit", "patch", "apply_patch", "notebook_create", "notebook_update"]);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ========== 守卫状态机（第 64 波：判据从「次数」改成「信息增益」）==========

/** 结果摘要：只归一化空白并截断 —— **不要**抹掉数字/时间戳，否则"文件真的变了"会被误判成没变 */
export function digestOf(output: unknown): string {
  const s = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const normalized = s.replace(/\s+/g, " ").trim();
  return normalized.length > 4000 ? normalized.slice(0, 4000) : normalized;
}

export class RepeatGuard {
  private readonly limits: RepeatGuardLimits;
  /** 本轮见过的**结果内容**（跨签名）—— 换十几种写法拿到同一份内容，同样是零信息增益 */
  private seenDigests = new Set<string>();
  /**
   * 连续"零信息增益"次数：每次都拿到**已经见过的内容**，而且期间没有任何写操作。
   * 这是**可证明的零进展**（不是"猜它可能卡住了"），也是本守卫唯一的升级依据。
   */
  private noGainStreak = 0;
  /** 已被判定为零增益的签名：不再执行（但**允许换新手段** —— 新签名照常放行） */
  private suppressedSignatures = new Set<string>();
  /** 写操作之后的第一份"老内容"是合法的新信息（世界变过了），宽容一次 */
  private mutatedSinceEvidence = false;
  private warned = false;
  /** 只读枚举的观察计数（仅用于提醒文案，**不参与拦截**） */
  private enumSeen = new Map<string, number>();
  private enumAdvised = new Set<string>();

  readonly stats = {
    /** 观察到的"零信息增益"重复次数 */
    noGainRepeats: 0,
    /** 见过多少份不同结果（= 真实进展的度量） */
    distinctResults: 0,
    suppressed: 0,
    stopped: 0,
    mutations: 0,
    /** 提醒次数（枚举/零增益） */
    advisories: 0,
  };

  constructor(limits: Partial<RepeatGuardLimits> = {}) {
    this.limits = { ...DEFAULT_GUARD_LIMITS, ...limits };
  }

  reset(): void {
    this.seenDigests.clear();
    this.noGainStreak = 0;
    this.suppressedSignatures.clear();
    this.mutatedSinceEvidence = false;
    this.warned = false;
    this.enumSeen.clear();
    this.enumAdvised.clear();
  }

  /** 写操作发生 —— 世界变了：之后的"老内容"也算新信息（宽容一次），并清空枚举观察 */
  noteMutation(): void {
    this.stats.mutations++;
    this.mutatedSinceEvidence = true;
    this.enumSeen.clear();
    this.enumAdvised.clear();
  }

  /** 当前的零信息增益连续次数（agentic-loop 用来判"该收手了"） */
  get noGainStreakCount(): number {
    return this.noGainStreak;
  }

  /**
   * 在执行**之后**调用：登记这次调用的结果，判定是否带来新信息。
   *
   * 这是整个守卫的**证据来源** —— 判据不是"你调了几次"，而是"你拿到的东西是不是已经有了"。
   */
  noteResult(name: string, input: Record<string, unknown> | undefined, output: unknown): { gained: boolean; streak: number } {
    const args = input ?? {};
    const signature = exactSignature(name, args);
    const digest = digestOf(output);

    // 写操作之后的第一次：世界已经变了，即使内容一样也按"新信息"处理并宽容一次
    if (this.mutatedSinceEvidence) {
      this.mutatedSinceEvidence = false;
      this.seenDigests.add(digest);
      this.stats.distinctResults++;
      this.noGainStreak = 0;
      return { gained: true, streak: 0 };
    }

    if (this.seenDigests.has(digest)) {
      this.noGainStreak++;
      this.stats.noGainRepeats++;
      if (this.noGainStreak >= this.limits.noGainSuppress) this.suppressedSignatures.add(signature);
      return { gained: false, streak: this.noGainStreak };
    }

    this.seenDigests.add(digest);
    this.stats.distinctResults++;
    this.noGainStreak = 0;
    return { gained: true, streak: 0 };
  }

  /**
   * 在执行**之前**调用。返回的 `message` 应追加到工具结果里（warn），
   * 或作为替代结果返回（suppress/stop）。
   *
   * 升级依据只有一条：**零信息增益**（见 `noteResult`）。
   * `cwd` 用于把「裸枚举命令」（`Get-ChildItem -Force`）归到真实目标路径上，仅供提醒文案使用。
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

    // 只读枚举分类：只为提醒文案（"你在反复看同一个目录"），不作为拦截依据
    let enumerateSignature: string | undefined;
    if (name === "bash" || name === "shell" || name === "run_command" || name === "terminal") {
      const command = String((args as any).command ?? (args as any).cmd ?? "");
      const intent = bashIntent(command, ctx.cwd);
      if (intent.kind === "mutate") {
        this.noteMutation();
        return { action: "allow" };
      }
      if (intent.kind === "enumerate") enumerateSignature = intent.signature;
    }

    const signature = exactSignature(name, args);

    // ===== 唯一的重判据：零信息增益 =====
    if (this.noGainStreak >= this.limits.noGainStop) {
      this.stats.stopped++;
      return {
        action: "stop",
        kind: "no-gain",
        signature,
        count: this.noGainStreak,
        message:
          `[REPEAT GUARD — STOP] 你连续 ${this.noGainStreak} 次拿到了**已经见过的完全相同的内容**` +
          `（期间没有任何写操作）—— 这是"零信息增益"的硬证据，说明当前手段已经不可能再推进任务。\n` +
          `现在停下来，改用以下之一：\n` +
          `  1) 换一个真正不同的手段（读具体文件、用搜索定位、问用户）；\n` +
          `  2) 如果你要找的东西确实不存在，**直接报告"未找到 + 已尝试的路径/命令"**；\n` +
          `  3) 如果需要调用方补充信息，明确写出你需要什么。`,
      };
    }

    if (this.suppressedSignatures.has(signature)) {
      // 这个**具体调用**已被证明拿不到新信息，不再执行。
      // 但**换新手段必须放行**（新签名不在此列）—— 否则模型永远没法改策略，
      // 那正是第 64 波要修掉的"拿次数/黑名单当可靠性"。
      // 同时把这次也算作零增益：否则被拦下的调用不产生证据，永远升不到"停"档。
      this.noGainStreak++;
      this.stats.noGainRepeats++;
      this.stats.suppressed++;
      if (this.noGainStreak >= this.limits.noGainStop) {
        this.stats.stopped++;
        return {
          action: "stop",
          kind: "no-gain",
          signature,
          count: this.noGainStreak,
          message:
            `[REPEAT GUARD — STOP] 你连续 ${this.noGainStreak} 次在同一个手段上打转` +
            `（拿到的是**已经见过的完全相同的内容**，期间没有任何写操作）—— 零信息增益，任务不可能靠它推进。\n` +
            `现在停下来：换一个真正不同的手段，或者直接报告"未找到 + 已尝试过的路径/命令"，或者说明你需要调用方补什么。`,
        };
      }
      return {
        action: "suppress",
        kind: "no-gain-signature",
        signature,
        count: this.noGainStreak,
        message:
          `[REPEAT GUARD] 跳过这次 ${name}：**同样的调用已经连续拿到完全相同的内容**` +
          `（连续第 ${this.noGainStreak} 次零信息增益），再执行一次不会有新信息。\n` +
          `请换一个**不同手段**（不同工具 / 不同目标 / 直接 read 具体文件），或者直接给出结论、报告缺什么。`,
      };
    }

    if (this.noGainStreak >= this.limits.noGainWarn && !this.warned) {
      this.warned = true;
      this.stats.advisories++;
      return {
        action: "warn",
        kind: "no-gain",
        signature,
        count: this.noGainStreak,
        message:
          `[SYSTEM REMINDER] 你连续 ${this.noGainStreak} 次拿到的内容与之前**完全相同**。` +
          `再重复同类调用不会有新信息 —— 请换手段，或直接基于已有信息推进/报告。`,
      };
    }

    // 只读枚举的提醒（文案价值；闸门在"零信息增益"那三档）
    if (enumerateSignature) {
      const n = (this.enumSeen.get(enumerateSignature) ?? 0) + 1;
      this.enumSeen.set(enumerateSignature, n);
      if (n >= this.limits.enumAdvisoryAt && !this.enumAdvised.has(enumerateSignature)) {
        this.enumAdvised.add(enumerateSignature);
        this.stats.advisories++;
        return {
          action: "warn",
          kind: "enumerate",
          signature: enumerateSignature,
          count: n,
          message:
            `[SYSTEM REMINDER] 你已经第 ${n} 次查看同一个目标：${truncate(enumerateSignature, 160)}。` +
            `如果这里没有你要的文件，**不要继续换写法重试** —— 直接说明缺什么，或改用已知路径 read。`,
        };
      }
    }

    if (GUARD_EXEMPT_TOOLS.has(name)) return { action: "allow" };
    return { action: "allow", signature };
  }
}
