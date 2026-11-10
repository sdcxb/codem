/**
 * 团队记忆（25:668）在 B 收口后的形态：
 * - 归属是**现有 AgentTeam**，不是 Bot/群绑定；
 * - 会话按 agent-teams 成员关系自动解析 teamId（普通会话/队长/成员）；
 * - 写入只有用户显式服务入口，模型没有管理工具；
 * - 别的团队/已移除成员读不到。
 *
 * | id | 钉什么 | 变红方式 |
 * |---|---|---|
 * | TM-B1 | 队长/成员会话解析到自己的团队，非成员 undefined | 不解析/误认领 ⇒ 红 |
 * | TM-B2 | 团队记忆写入后，同团队预览可见；别的团队不可见 | 写成全局/不按 teamId 过滤 ⇒ 红 |
 * | TM-B3 | removed 成员、归档团队不解析/不写 | 忽略成员状态 ⇒ 红 |
 * | TM-B4 | 空 key/content、未知团队显式失败且不写 | 静默成功 ⇒ 红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { setGlobalSubagentRuntime } from "../core/subagent/index";
import type { SubagentRuntime } from "../core/subagent/runtime";
import { AgentTeamsService } from "../core/provider/agent-teams-service";
import {
  readTeamMemoryPreview,
  rememberTeamMemory,
  resolveTeamIdForSession,
} from "../core/memory/team-memory";

function installRuntime(): void {
  let seq = 0;
  const runtime = {
    startContinuable: async () => {
      seq += 1;
      return { childId: `tm-child-${seq}` };
    },
    getTask: () => undefined,
    followup: async () => undefined,
  };
  // 只在本文件里给 AgentTeamsService.addMember 用；不启动真实子代理。
  (globalThis as any).__tmRuntime = runtime;
}

beforeEach(async () => {
  setStoragePort(createFakeStoragePort());
  AgentTeamsService._reset();
  installRuntime();
  const service = AgentTeamsService.getInstance();
  const team = service.create({ name: "团队记忆队", captainSessionId: "captain-tm" });
  await service.addMember(team.id, { name: "成员甲", role: "执行", parentSessionId: "captain-tm" });
});

afterEach(() => {
  setStoragePort(null);
  AgentTeamsService._reset();
  vi.restoreAllMocks();
});

describe("团队记忆 · 接入现有 AgentTeam", () => {
  it("TM-B1：队长/成员会话解析到自己的团队；无关会话 undefined", () => {
    const team = AgentTeamsService.getInstance().listAll()[0];
    expect(resolveTeamIdForSession("captain-tm")).toBe(team.id);
    expect(resolveTeamIdForSession(team.members[0].id)).toBe(team.id);
    expect(resolveTeamIdForSession("some-other-session")).toBeUndefined();
  });

  it("TM-B2：写后同团队可读，别的团队读不到", () => {
    const service = AgentTeamsService.getInstance();
    const team = service.listAll()[0];
    const result = rememberTeamMemory({
      teamId: team.id,
      key: "release-window",
      content: "发布窗口：周五 18:00",
    });
    expect(result.ok).toBe(true);
    expect(readTeamMemoryPreview(team.id)).toContain("发布窗口");

    const other = service.create({ name: "别的队", captainSessionId: "captain-other" });
    expect(readTeamMemoryPreview(other.id)).not.toContain("发布窗口");
  });

  it("TM-B3：removed 成员不再解析；归档团队不再解析", () => {
    const service = AgentTeamsService.getInstance();
    const team = service.listAll()[0];
    const member = team.members[0];
    service.removeMember(team.id, member.name);
    expect(resolveTeamIdForSession(member.id)).toBeUndefined();

    const second = service.create({ name: "待归档队", captainSessionId: "captain-archive" });
    service.deleteTeam(second.id);
    expect(resolveTeamIdForSession("captain-archive")).toBeUndefined();
  });

  it("TM-B4：空输入/未知团队显式失败，不写任何内容", () => {
    const team = AgentTeamsService.getInstance().listAll()[0];
    expect(rememberTeamMemory({ teamId: team.id, key: "", content: "x" }).ok).toBe(false);
    expect(rememberTeamMemory({ teamId: team.id, key: "k", content: "   " }).ok).toBe(false);
    expect(rememberTeamMemory({ teamId: "no-such-team", key: "k", content: "x" }).ok).toBe(false);
    expect(readTeamMemoryPreview(team.id)).not.toContain("x");
  });
});
