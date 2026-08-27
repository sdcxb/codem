import type { ProcessorEvent } from "../llm/processor";
import { getLang } from "../i18n/lang";

// ========== Sub-agent Types ==========

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

// ========== Sub-agent Activity Tracking ==========
export interface SubagentActivity {
  id: string;
  type: "thinking" | "tool";
  label: string;
  status: "running" | "done";
  startedAt: number;
  completedAt?: number;
}

export interface SubagentTask {
  id: string;
  name: string;
  parentId: string;
  agentId: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  persistent: boolean;
  result?: SubagentResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeout?: number;
  /** Real-time activity list for execution view */
  activities?: SubagentActivity[];
  /** P1-7: Agent Profile ID — links to agent_profiles table for persistent identity */
  profile_id?: string;
}

export interface SubagentResult {
  status: "success" | "partial" | "failed" | "blocked";
  summary: string;
  output: string;
  filesTouched: string[];
  findings: string[];
}

// ========== Task Result Parser ==========

/**
 * 解析子智能体输出为结构化结果。
 * 新系统的 InProcessSpawnProvider 和 SubagentRuntime 都使用此函数。
 */
export function parseTaskResult(output: string): SubagentResult {
  // Filter out <system-reminder> tags
  const cleanOutput = output.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  
  const lines = cleanOutput.split("\n");
  let status: SubagentResult["status"] = "success";
  let summary = "";
  let filesTouched: string[] = [];
  let findings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 解析状态（兼容中英文标记）
    if (trimmed.startsWith("**状态**:") || trimmed.startsWith("**Status**:")) {
      const statusStr = trimmed.replace(/\*\*(?:状态|Status)\*\*:/, "").trim().toLowerCase();
      if (statusStr.includes("success") || statusStr.includes("成功")) status = "success";
      else if (statusStr.includes("partial") || statusStr.includes("部分")) status = "partial";
      else if (statusStr.includes("failed") || statusStr.includes("失败")) status = "failed";
      else if (statusStr.includes("blocked") || statusStr.includes("阻塞")) status = "blocked";
    }

    // 解析摘要
    if (trimmed.startsWith("**摘要**:") || trimmed.startsWith("**Summary**:")) {
      summary = trimmed.replace(/\*\*(?:摘要|Summary)\*\*:/, "").trim();
    }

    // 解析涉及的文件
    if (trimmed.startsWith("**文件**:") || trimmed.startsWith("**Files touched**:")) {
      const filesStr = trimmed.replace(/\*\*(?:文件|Files touched)\*\*:/, "").trim();
      if (filesStr !== "(none)" && filesStr !== "无") {
        filesTouched = filesStr.split(",").map((f) => f.trim());
      }
    }

    // 解析发现
    if (trimmed.startsWith("**发现**:") || trimmed.startsWith("**Findings worth promoting**:")) {
      const findingsStr = trimmed.replace(/\*\*(?:发现|Findings worth promoting)\*\*:/, "").trim();
      if (findingsStr !== "(none)" && findingsStr !== "无") {
        findings = findingsStr.split("\n").map((f) => f.replace(/^-\s*/, "").trim()).filter(Boolean);
      }
    }
  }

  return {
    status,
    summary: summary || (getLang() === "zh" ? "任务已完成" : "Task completed"),
    output: cleanOutput,
    filesTouched,
    findings,
  };
}
