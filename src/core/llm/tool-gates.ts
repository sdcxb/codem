/**
 * tool-gates — 进程内 SDK（`run_code` / `workflow`）**共用的权限闸门**。
 *
 * ## 为什么要有这个文件
 *
 * `run_code` 与 `workflow` 都能在脚本里通过 `sdk` 调 `bash` / `write`：
 *
 * - `tools/run-code.ts` —— 第 ? 波修过一次「闸门旁路」：`sdk.bash` 直接
 *   `executeCommand(...)`、`sdk.write` 直接 `writeFile(...)`，从不经过
 *   `analyzeBashCommand` 与 `write` 工具的覆盖确认。修法是就地加了两个私有函数
 *   （`refuseDangerousCommand` / `confirmWriteIfNeeded`）。
 * - `workflow-engine.ts` —— **同一个缺口原封未动**：`sdk.bash` 直接 `executeCommand`、
 *   `sdk.write` 直接 `writeFile`。而且 `workflow` 在
 *   `isAutoApprovable`（`security-mode.ts:149-184`，末尾 `return true`）下同样恒为
 *   「可自动放行」—— 也就是说把 `Remove-Item -Recurse -Force …` 包进 workflow
 *   就能绕过危险命令闸门。
 *
 * 两处的闸门**必须是同一份实现**：`run-code.ts` 原来的注释已经点明，
 * 本地复刻的 `calculateContentSimilarity` / 阈值与 `tools.ts` 那份会漂移，
 * 且没有测试能发现。抽到这里之后，`run_code` 与 `workflow` 共用同一道闸门，
 * 判据只有一份。
 *
 * ## 语义没有变
 *
 * 本文件里的三段逻辑是 `run-code.ts` 原实现的**逐字搬运**：
 * 危险命令一律拒绝（分析器抛错同样拒绝 = fail-closed），
 * 受保护路径先拒绝，覆盖确认与 `write` 工具同判据、且读不到现有内容时按
 * 「可能已存在」处理（方向保守）。唯一新增的是 `toolLabel` 参数 ——
 * 它只用来把「是谁拒绝的（run_code / workflow）」写进给模型看的理由里，
 * 默认值 `"run_code"` 使 `run_code` 侧的文案**逐字不变**。
 */

import type { ToolContext } from "./tools";
import { analyzeBashCommand, evaluateWithBashAnalysis } from "../permission/bash-analyzer";

// ========== 与 write 工具对齐的覆盖保护参数 ==========

/**
 * `tools.ts` 的 `OVERWRITE_SIMILARITY_THRESHOLD`（0.1）—— 同一判据。
 *
 * `tools.ts` 那份是模块私有的，无法 import（改动 `tools.ts` 不在本轮范围内），
 * 所以这里是同一判据的第二份实现，**存在漂移风险**：`tools.ts` 那份若改了阈值或
 * 算法，这里不会自动跟随。要彻底消除需要把 `tools.ts` 的实现也搬进来并导出。
 */
export const OVERWRITE_SIMILARITY_THRESHOLD = 0.1;

/**
 * 与 `src/core/llm/tools.ts:303-318` 的 `calculateContentSimilarity` 逐行等价：
 * 按行去空白求交集占比。返回 0.0（完全不同）～ 1.0（逐字相同）。
 *
 * export 是为了能被测试直接钉住算法（`pi-p2-run-code-permission-parity.test.ts`
 * 从 `run-code.ts` 重新导出同一个函数）。
 */
export function calculateContentSimilarity(oldContent: string, newContent: string): number {
  if (oldContent === newContent) return 1.0;
  if (!oldContent || !newContent) return 0.0;

  const oldLines = new Set(oldContent.split("\n").map(l => l.trim()).filter(l => l.length > 0));
  const newLines = newContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (newLines.length === 0) return 0.0;

  let commonLines = 0;
  for (const line of newLines) {
    if (oldLines.has(line)) commonLines++;
  }

  return commonLines / Math.max(newLines.length, oldLines.size);
}

/**
 * 读盘失败是不是「这个路径不存在」。
 *
 * ⚠️ 这是**文本判据**，而文本判据会随文案微调静默失效（仓库里
 * `src/core/storage/session-jsonl.ts` 的 `isFileMissingError` 已经写过这条教训）。
 * 这里用它是因为**方向是保守的**：判成「不存在」⇒ 当新建（不问）；
 * **判不出来 ⇒ 按「可能已存在」处理（去问）**。所以它误判的后果是
 * 「多问一次」，而不是「少问一次」。
 */
function isMissingPathError(message: string): boolean {
  return (
    // Node / fetch 层惯例（测试桩与部分 JS 侧路径用这个）
    /\bENOENT\b/.test(message) ||
    /\bENOTDIR\b/.test(message) ||
    // Rust `std::fs` 侧的文案（真机链路：`Failed to read ...: os error 2`）
    /os error 2\b/.test(message) ||
    /no such file/i.test(message) ||
    /cannot find the (file|path)/i.test(message) ||
    /找不到指定的(路径|文件)/.test(message)
  );
}

// ========== 闸门 1：危险 bash 命令 ==========

/**
 * 判断 `sdk.bash` 的命令是否必须**拒绝执行**（fail-closed）。
 *
 * 返回 `null` = 允许执行；返回字符串 = 拒绝原因（调用方抛错，脚本与模型都能读到）。
 *
 * ## 规则为什么是「dangerous 一律拒绝」而不是「按模式放行」
 *
 * `analyzeBashCommand` 的 `dangerous` 分类是 `isAutoApprovable`
 * （`security-mode.ts:149-184`）唯一会否掉的东西 —— 也就是说，
 * `dangerous` 的含义正是「**在任何模式下都不许静默执行**」：
 *
 * - `full`：用户显式放弃审批，直接调 `bash` 工具确实会执行；但进程内 SDK 内部
 *   拿不到任何审批通道（`ToolContext` 没有 `executeTool`/`onPermissionRequest`，
 *   见 `tools.ts:409-439`）。此时若放行，等于把「用户放弃审批」偷换成
 *   「模型可以在一个被 `isAutoApprovable` 恒判可放行的外壳里执行危险命令」——
 *   而真正的危险闸门（`evaluateWithBashAnalysis`，`bash-analyzer.ts:291`）
 *   只会把 `allow` 升级成 `ask`，**不会**降级成 deny。所以「拒绝」与之一致。
 * - `ask` / `auto`：本应询问用户。这里**没有**可用的询问通道（同样的缺口），
 *   而 `agentic-loop.ts:1005-1019` 已经为「需要问却没人可问」立了先例：
 *   **明确拒绝并说清原因**，不许落到缺省放行。这里照做。
 *
 * 结论：拒绝 + 告诉模型去直接调 `bash` 工具（那条路上用户会被问到）是唯一
 * 既不放行危险命令、又不假装问过的行为。
 *
 * ## fail-closed
 *
 * 分析器抛错时**同样拒绝**（`security-mode.ts:159-163` 的 `catch { return false }`
 * 是同一约定的先例）：拿不准就不执行，而不是当作安全。
 *
 * @param toolLabel 只影响给模型看的理由文本（谁拒绝的）。默认 `"run_code"`，
 *   使 `run_code` 侧文案与搬进来之前**逐字相同**。
 */
export function refuseDangerousCommand(
  command: string,
  securityMode: ToolContext["securityMode"],
  timeoutMs: number,
  toolLabel: string = "run_code",
): string | null {
  let analysis: ReturnType<typeof analyzeBashCommand>;
  try {
    analysis = analyzeBashCommand(command);
  } catch (err: any) {
    return (
      `Error: refused to execute this command inside ${toolLabel} — the bash security analyzer threw ` +
      `(${err?.message || String(err)}), so it was treated as unsafe (fail-closed). ` +
      `Call the \`bash\` tool directly instead so the normal permission checks apply. ` +
      `[command: ${command}] [timeout_ms: ${timeoutMs}]`
    );
  }

  if (analysis.classification !== "dangerous") return null;

  const detail = analysis.dangerousPatterns.join("; ");
  let evaluated = "";
  try {
    const settlement = evaluateWithBashAnalysis(command, "allow");
    evaluated = settlement.action === "ask"
      ? ` The user approval gate would have to be honoured (the analyzer raises the action to 「ask」), but ${toolLabel} has no approval channel.`
      : "";
  } catch (err: any) {
    // 它抛错**不影响「拒绝」这个决定**（拒绝是无条件的），但也不能静默吞掉：
    // 写进理由里，否则排查时分不清「确定危险」与「判不出来所以保守拒绝」。
    evaluated = ` (evaluateWithBashAnalysis also threw: ${err?.message || String(err)}; refusing conservatively)`;
  }

  return (
    `Error: refused to execute this command inside ${toolLabel} — analyzeBashCommand classified it as "dangerous". ` +
    `Detected patterns: ${detail}. ` +
    `${toolLabel} executes nested calls without a user-approval channel, so a dangerous command cannot be approved here; ` +
    `refusing is the fail-closed behaviour.${evaluated} ` +
    `Call the \`bash\` tool directly with the same command so the user is asked. ` +
    `[command: ${command}] [timeout_ms: ${timeoutMs}] [security_mode: ${securityMode ?? "unset"}]`
  );
}

// ========== 闸门 2：受保护路径 ==========

/**
 * `sdk.write` 的受保护路径检查 —— 与 `write` 工具同一判据
 * （`tools.ts:1385-1391`，`isProtectedPath` 在 `tools.ts:291`）。
 *
 * 返回 `null` = 允许；返回字符串 = 拒绝原因。
 *
 * `isProtectedPath` 是**值导入**，而 `tools.ts` 静态 import 了本模块的两个使用者
 * （`workflow-engine.ts` / `tools/run-code.ts`），静态 import 会形成真实环。
 * 所以与 `run-code.ts` 原来的写法一致：**动态 import**（既避开环，
 * 也把 `tools.ts` 的求值推迟到真正写盘时）。
 */
export async function refuseProtectedPathWrite(path: string): Promise<string | null> {
  const { isProtectedPath } = await import("./tools");
  if (!isProtectedPath(path)) return null;
  return (
    `Error: This path is protected and cannot be written to by sdk.write: "${path}". ` +
    `Protected paths include .git/, .env, .codem-snapshots/, node_modules/. ` +
    `Use the 'edit' tool for modifying existing files in safe locations.`
  );
}

// ========== 闸门 3：覆盖写确认 ==========

/**
 * `sdk.write` 的覆盖确认 —— 与 `write` 工具（`tools.ts:1400-1460`）同一判据：
 * 文件已存在、非空、且与**逐行等价**的相似度低于 0.1 时，
 * 在 `securityMode === "ask"` 且有 `onWriteConfirm` 的情况下询问用户（「ask」模式），
 * 并尊重结果（reject / custom ⇒ 不写盘并报明原因）。
 *
 * 与 `write` 工具的两点差异（都不是放宽）：
 * 1. 这里**没有** `append` 语义（`sdk.write` 的契约就是覆盖），所以不做 append 分支。
 * 2. `write` 工具在「没有回调」时打印 warning 后照写；这里同样照写 ——
 *    闸门的缺失由工具的 guidance/description 如实说明，不在这一层发明新策略。
 *
 * @param toolLabel 只用于日志前缀与拒绝文案里「谁拒绝的」。默认 `"run_code"`，
 *   使 `run_code` 侧的**拒绝文案**与搬进来之前逐字相同（只有 `console.warn` 的前缀
 *   从 `[run-code]` 变成 `[run_code]`，信息量不变）。
 */
export async function confirmWriteIfNeeded(
  path: string,
  content: string,
  ctx: ToolContext,
  toolLabel: string = "run_code",
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let existingContent: string | null = null;
  /**
   * 读盘失败**不能**被当成「文件不存在」。旧实现的 catch 是空的 ⇒ `existingContent` 保持 null
   * ⇒ 走下面的「新建」分支 ⇒ **跳过覆盖确认**。那是这一层的 fail-open，而且窗口是真实的：
   * 二进制/超大文件、权限、引擎暂时不可用都会让 `read_file` 失败，而 `write_file` 可能照样写得下去
   * —— 于是用户在被覆盖之前**一次都没被问过**。
   *
   * 现在的方向是保守的：只有**能确认不存在**才当新建；**判不出来一律按「可能已存在」处理**（去问）。
   */
  let readFailure: string | null = null;
  try {
    const { readFile } = await import("../file-api");
    existingContent = await readFile(path);
  } catch (err: any) {
    const detail = String(err?.message ?? err ?? "");
    readFailure = isMissingPathError(detail) ? null : detail;
  }

  if (readFailure === null && (existingContent === null || existingContent.length === 0)) return { ok: true };

  const secMode = ctx.securityMode || "ask";
  const canConfirm = Boolean(ctx.onWriteConfirm) && secMode === "ask";

  if (readFailure === null) {
    const similarity = calculateContentSimilarity(existingContent!, content);
    if (similarity >= OVERWRITE_SIMILARITY_THRESHOLD) return { ok: true };
    if (!canConfirm) {
      // 与 write 工具一致：auto/full 模式跳过 Diff 确认；没有回调时无从确认。
      return { ok: true };
    }
  } else if (!canConfirm) {
    // 读不到、又无从确认（auto/full 或无回调）：与 write 工具一致不阻塞，但**留下痕迹**。
    console.warn(
      `[${toolLabel}] sdk.write could not read the existing content of "${path}" (${readFailure}); ` +
        `proceeding without an overwrite confirmation (mode=${secMode}, onWriteConfirm=${Boolean(ctx.onWriteConfirm)})`,
    );
    return { ok: true };
  }

  const confirmResult = await ctx.onWriteConfirm!({
    filePath: path,
    existingContent: existingContent ?? "",
    newContent: content,
  });
  if (confirmResult.action === "reject") {
    return {
      ok: false,
      reason:
        `Error: the user rejected the overwrite of "${path}" by sdk.write inside ${toolLabel} ` +
        (readFailure === null
          ? `(existing ${existingContent!.length} bytes, similarity ${calculateContentSimilarity(existingContent!, content).toFixed(3)} < ${OVERWRITE_SIMILARITY_THRESHOLD}). `
          : `(its existing content could not be read: ${readFailure}). `) +
        `Nothing was written. Use the \`edit\` tool for targeted modifications, or ask the user how to proceed.`,
    };
  }
  if (confirmResult.action === "custom") {
    return {
      ok: false,
      reason:
        `Error: sdk.write did not write "${path}" — the user gave a ONE-TIME instruction for this write instead of ` +
        `approving the overwrite: "${confirmResult.instruction}". ` +
        `Nothing was written. Apply that instruction (prefer the \`edit\` tool) and then write again; ` +
        `the instruction applies only to that one operation.`,
    };
  }
  return { ok: true };
}
