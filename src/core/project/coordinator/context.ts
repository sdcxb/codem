import {
  readBrief,
  readGates,
  readProjectState,
  missingEvidenceRefs,
  scanReports,
} from "./storage";

/**
 * 组装协调者每轮的系统上下文。
 *
 * **只读项目状态**：brief + thread registry + 最近报告 + gate；不读任何 thread 的聊天记录。
 * 这是“协调者能不能承载长项目”的核心：上下文丢了也能从这些文件重建。
 *
 * 返回空串 = 这个会话不是协调者（或者项目状态里没有它），调用方直接跳过注入。
 */
export async function buildCoordinatorContext(
  projectPath: string | undefined,
  sessionId: string
): Promise<string> {
  if (!projectPath) return "";
  const state = await readProjectState(projectPath);
  if (!state.coordinatorSessionId || state.coordinatorSessionId !== sessionId) return "";

  const [brief, scan, gates] = await Promise.all([
    readBrief(projectPath),
    scanReports(projectPath),
    readGates(projectPath),
  ]);
  const reports = scan.valid;

  const threadLines = state.threads.length
    ? state.threads.map((t) => {
        const report = t.lastReportId ? ` · 最新报告 ${t.lastReportId}` : "";
        return `- ${t.sessionId}｜${t.title}｜${t.status}${report}`;
      }).join("\n")
    : "- （还没有注册 thread）";

  const latest = reports.slice(-12);
  const reportLines: string[] = [];
  for (const r of latest) {
    const gatesText = r.gates?.length
      ? ` · gates: ${r.gates.map((g) => `${g.id}=${g.passed ? "pass" : "fail"}`).join(",")}`
      : "";
    const conflict = r.conflict ? ` · conflict: ${r.conflict}` : "";
    const missing = await missingEvidenceRefs(projectPath, r);
    const evidenceText = missing.length ? ` · ⚠ 证据缺失: ${missing.join(",")}` : "";
    reportLines.push(`- ${r.report_id}｜${r.thread_id}｜${r.status}｜${r.summary}${gatesText}${conflict}${evidenceText}`);
  }
  const reportText = reportLines.length ? reportLines.join(String.fromCharCode(10)) : "- （还没有报告）";

  const gateLines = gates.length
    ? gates.map((g) => `- ${g.id}｜${g.title}｜${g.passed ? "pass" : "fail"}｜${g.verified_by}`).join("\n")
    : "- （还没有登记 gate）";

  const context = [
    "## 项目协调者上下文（只读项目状态）",
    "",
    "你是这个项目的协调者。下面是你**唯一**的项目事实来源；不要声称读过任何 thread 的聊天记录。",
    "需要细节时，让对应 thread 重新交报告，或直接读报告文件，不要凭空补全。",
    "",
    `### 项目 brief\n${brief.trim().slice(0, 5000) || "（brief 为空）"}`,
    "",
    `### thread registry（${state.threads.length} 个）\n${threadLines}`,
    "",
    `### 最近报告（${latest.length}/${reports.length}）\n${reportText}`,
    "",
    `### 验收 gate\n${gateLines}`,
    "",
    "### 协调规则",
    "- `done` 报告必须有日志证据；`passed` gate 必须由命令验证并带 evidence_ref。",
    "- 报告之间冲突时先看 gate/证据，不要按标题猜。",
    "- 需要用户拍板时，blocked 报告必须给至少 2 个选项和默认项。",
  ].join("\n");

  // 硬预算：协调者上下文不挤占 thread 的窗口；超了按字符截断，并明确告知。
  const MAX = 9000;
  if (context.length <= MAX) return context;
  return context.slice(0, MAX) + "\n\n[协调者上下文已截断：完整内容见 .codem/project/]";
}
