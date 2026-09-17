import type { Session } from "../llm/session";
import { domainDelete, domainReadMany, domainWrite } from "./domain-store";
import { reportPersistFailure } from "./persist-failure";

// ========== 迁移期分流（P3 第 12 段） ==========
//
// `v2_sessions` 是"整会话一把存"的形态：`messages` / `total_usage` 两列存的是 JSON 文本。
// 因此这里必须**逐行转换**（对象 ←→ JSON 字符串），不能像普通列那样直传。

const TABLE = "v2_sessions";

/** 线协议行 → Session（JSON 列需要解析） */
function wireToSession(row: Record<string, unknown>): Session {
  const parse = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    title: String(row.title ?? ""),
    model: String(row.model ?? ""),
    messages: parse(row.messages, [] as unknown[]),
    totalUsage: parse(row.total_usage, { promptTokens: 0, completionTokens: 0, cost: 0 }),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  } as Session;
}

/** Session → 线协议行（JSON 列序列化） */
function sessionToWire(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    project_id: session.projectId,
    title: session.title,
    model: session.model ?? "",
    messages: JSON.stringify(session.messages ?? []),
    total_usage: JSON.stringify(session.totalUsage ?? { promptTokens: 0, completionTokens: 0, cost: 0 }),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function loadV2Sessions(): Map<string, Session> {
  const rust = domainReadMany(TABLE, wireToSession);
  if (rust) {
    const sessions = new Map<string, Session>();
    for (const s of rust) sessions.set(s.id, s);
    return sessions;
  }
  const sessions = new Map<string, Session>();
  /*
   * 第 17 轮（L4）：旧库回退已删。只剩 B 态（端口在 rust，只是镜像没就绪）→ 返回空 Map，
   * 语义即"本进程数据源是端口，端口还没就绪 → 现在没有"。
   */
  return sessions;
}

export function saveV2Session(session: Session): void {
  if (domainWrite(TABLE, [sessionToWire(session)], { mode: "replace", scope: "v2Session.save", note: "会话未保存" })) {
    return;
  }
  /*
   * 第 17 轮（L4）：旧库回退（查存量 → UPDATE/INSERT + persistDatabase）已删。
   * 只剩 B 态：端口在但镜像没就绪 → **不能**写旧库（读写分裂），如实上报。
   * 原实现的旧库写入在 try **之外** —— 那时会直接抛出去，
   * 而 saveV2Session 的调用方多在流式回调里，抛出会打断整轮对话。
   */
  reportPersistFailure("v2Session.save", new Error("会话域端口未接手（镜像未就绪）"), "v2 会话未保存");
}

export function deleteV2Session(id: string): void {
  if (domainDelete(TABLE, { id }, { scope: "v2Session.delete", note: "会话未删除" })) return;
  // 第 17 轮（L4）：旧库回退已删；删除必须如实上报（静默失败会让墓碑缺失 → 下次从日志重建时"复活"）
  reportPersistFailure("v2Session.delete", new Error("会话域端口未接手（镜像未就绪）"), "v2 会话未删除");
}
