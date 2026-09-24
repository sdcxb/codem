/**
 * 「这次调用算不算产出了交付物」的证据分级（第 83 波）
 *
 * ## 为什么需要单独一块（用户现场）
 *
 * 停滞守卫（`stall-guard.ts`）的判据是"计划没动 + 没产出交付物"。而"产出交付物"这一半
 * 原来由 `isArtifactTool()` 判定：**任何被 `bashIntent` 判成 `mutate` 的命令都算**。
 * 问题在于 `mutate` 里混了两类完全不同的东西：
 *
 *   · **可证明**会改盘（Set-Content / Remove-Item / 重定向 / 新建 / 复制…）；
 *   · **可能**会改盘（python / node / npm / git / cargo / docker / curl…）。
 *
 * 于是"用解释器脚本当读手段"的会话（真机现场：b 会话反复跑 `python _tmp_extract.py`，
 * 只读、只打印）**每一轮都被算成产出了交付物** → 停滞计数永远清零 → 停滞守卫也成了摆设。
 * 加上重复守卫当时也被"解释器=mutate"短路，同一场事故里**四道阀门全部失效**。
 *
 * ## 这里的判据（窄、有证据、可单测）
 *
 * - 可证明的写：算交付物，并**清空"重复命令"记忆**（世界变了，重新跑同一个脚本是合理的）；
 * - 可能写的命令：**同一条命令**（签名相同）在没有任何可证明写操作的情况下反复出现时，
 *   只把前几次当交付物 —— 反复跑同一条命令不是"产出"，是原地打转；
 * - 只读枚举/查询：不算（原有行为）。
 *
 * 这样既不会误杀"构建 → 编译 → 跑测试 → 再构建"这种**命令各不相同**的正常长任务，
 * 也能让"同一条命令跑几十遍"重新落进停滞守卫的射程。
 */

/**
 * 只读查询：这些命令**看起来**会被 `bashIntent` 归成 `mutate`（git/npm/pip/cargo 都在
 * "可能写"清单里），但它们明确是查询，不能算"产出了交付物" ——
 * 否则一个反复 `git status` 的会话永远判不出停滞（第 65 波审计结论，这里保持一致）。
 */
const READ_ONLY_QUERY_RE =
  /^\s*(git\s+(status|log|diff|show|branch|remote|config|describe|rev-parse)|npm\s+(ls|list|view|outdated|why)|pnpm\s+(list|why)|pip\s+(list|show|freeze)|cargo\s+(tree|metadata))\b/i;

/** 判定结果：为什么算/不算交付物（便于日志与用例断言） */
export type ArtifactVerdict =
  | "provable"           // 可证明会改盘的命令 / 写文件类工具
  | "speculative-ok"     // 可能写的命令，但还没有反复出现 → 先算作推进
  | "speculative-repeat" // 可能写的命令，同一条在没有任何真实写入前反复出现 → 不算推进
  | "read-only"          // 只读枚举 / 查询 / 读工具 → 不算
  | "failed";            // 结果看起来是失败 → 不算

/** 默认允许"同一条可能写的命令"在没有任何可证明写操作前被算作交付物的次数 */
const DEFAULT_SPECULATIVE_ARTIFACT_ALLOWANCE = 3;

export class ArtifactTracker {
  private readonly allowance: number;
  /** 自上次"可证明的写"以来，每条可能写的命令出现了几次 */
  private speculativeCounts = new Map<string, number>();
  readonly stats = { provable: 0, speculativeKept: 0, speculativeVetoed: 0, resets: 0 };

  constructor(allowance: number = DEFAULT_SPECULATIVE_ARTIFACT_ALLOWANCE) {
    this.allowance = Math.max(1, allowance);
  }

  reset(): void {
    this.speculativeCounts.clear();
  }

  /** 归一化命令签名：压缩空白即可（不做语义归并，避免把不同命令误判成同一条） */
  private signatureOf(command: string): string {
    return command.replace(/\s+/g, " ").trim();
  }

  /**
   * 记一次工具调用，并回答"这次算不算产出了交付物"。
   *
   * @param name 工具名
   * @param args 工具入参
   * @param output 工具输出（用于识别失败）
   * @param intent bash 命令的意图判定结果（由调用方提供，避免这里重复解析命令）
   */
  note(
    name: string,
    args: Record<string, any> | undefined,
    output: unknown,
    intent: { kind: "enumerate" | "mutate" | "other"; provable?: boolean; signature?: string } | null,
  ): { artifact: boolean; verdict: ArtifactVerdict } {
    const text = typeof output === "string" ? output : "";
    const failed = /^\s*(error|错误|failed|Traceback)/i.test(text) || /not found|权限不足|no such file/i.test(text);
    if (failed) return { artifact: false, verdict: "failed" };

    // ── 写文件类工具：直接算交付物，并且"世界变了" → 清空重复命令记忆
    if (name === "write" || name === "edit" || name === "multi_edit" || name === "patch" || name === "apply_patch") {
      this.speculativeCounts.clear();
      this.stats.provable++;
      this.stats.resets++;
      return { artifact: true, verdict: "provable" };
    }
    if (name === "notebook_create" || name === "notebook_update") {
      this.speculativeCounts.clear();
      this.stats.provable++;
      this.stats.resets++;
      return { artifact: true, verdict: "provable" };
    }

    // ── bash 类：按意图分级
    if (name === "bash" || name === "shell" || name === "run_command" || name === "terminal") {
      const cmd = String(args?.command ?? args?.cmd ?? "");
      const kind = intent?.kind ?? "other";
      // 第 65 波审计结论：只读查询（git status / npm view / pip list…）不算干活 —— 先于一切分级
      if (READ_ONLY_QUERY_RE.test(cmd.trim())) return { artifact: false, verdict: "read-only" };
      if (kind === "enumerate") return { artifact: false, verdict: "read-only" };
      if (kind === "mutate" && intent?.provable !== false) {
        this.speculativeCounts.clear();
        this.stats.provable++;
        this.stats.resets++;
        return { artifact: true, verdict: "provable" };
      }
      if (kind === "other") return { artifact: false, verdict: "read-only" };

      // 可能写：只在"同一条命令反复出现"时收回"推进"的判定
      const sig = this.signatureOf(cmd);
      const seen = (this.speculativeCounts.get(sig) ?? 0) + 1;
      this.speculativeCounts.set(sig, seen);
      if (seen <= this.allowance) {
        this.stats.speculativeKept++;
        return { artifact: true, verdict: "speculative-ok" };
      }
      this.stats.speculativeVetoed++;
      return { artifact: false, verdict: "speculative-repeat" };
    }

    if (name === "install" || name === "run_test") return { artifact: true, verdict: "provable" };
    return { artifact: false, verdict: "read-only" };
  }

  /** 某条命令至今被记为"可能写"的次数（诊断/用例用） */
  speculativeCountOf(command: string): number {
    return this.speculativeCounts.get(this.signatureOf(command)) ?? 0;
  }
}
