/**
 * 监控面板的展示文案与颜色映射（跨面板复用，避免同一语义在多处各写一遍）。
 */

import type { ActivitySeverity, LibraryEventKind } from "../../types";

/** 事件类别 → 双语标签 */
const KIND_LABEL: Record<LibraryEventKind, [string, string]> = {
  session: ["会话", "session"],
  team: ["团队", "team"],
  task: ["任务", "task"],
  tool: ["工具", "tool"],
  agent: ["智能体", "agent"],
  error: ["错误", "error"],
  cost: ["成本", "cost"],
  system: ["系统", "system"],
};

export function eventKindLabel(kind: LibraryEventKind | string, zh: boolean): string {
  const hit = KIND_LABEL[kind as LibraryEventKind];
  return hit ? (zh ? hit[0] : hit[1]) : String(kind);
}

/** 事件类别 → 语义令牌名 */
export function eventKindToken(kind: LibraryEventKind | string): string {
  switch (kind) {
    case "task":
      return "--success";
    case "tool":
      return "--accent";
    case "agent":
      return "--info";
    case "error":
      return "--error";
    case "team":
      return "--security-auto";
    case "cost":
      return "--security-full";
    default:
      return "--text-muted";
  }
}

/** 严重度 → 语义令牌名 */
export function severityToken(s: ActivitySeverity | string): string {
  switch (s) {
    case "bad":
      return "--error";
    case "wait":
      return "--warning";
    case "active":
      return "--accent";
    case "ok":
      return "--success";
    default:
      return "--text-muted";
  }
}

/** 严重度 → 双语标签 */
export function severityLabel(s: ActivitySeverity | string, zh: boolean): string {
  const map: Record<string, [string, string]> = {
    bad: ["失败", "error"],
    active: ["进行", "running"],
    ok: ["完成", "done"],
    wait: ["等待", "wait"],
    off: ["空闲", "idle"],
  };
  const hit = map[s];
  return hit ? (zh ? hit[0] : hit[1]) : String(s);
}

/** HH:MM:SS */
export function clockOf(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** HH:MM */
export function hhmmOf(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 成员状态 → 双语标签 + 令牌 */
export function memberStatusMeta(status: string): { token: string; zh: string; en: string } {
  switch (status) {
    case "working":
      return { token: "--warning", zh: "工作中", en: "working" };
    case "idle":
      return { token: "--success", zh: "空闲", en: "idle" };
    case "absent":
      return { token: "--text-muted", zh: "离线", en: "absent" };
    case "removed":
      return { token: "--text-muted", zh: "已移除", en: "removed" };
    default:
      return { token: "--text-muted", zh: status, en: status };
  }
}
