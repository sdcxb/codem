/**
 * 团队记忆的**用户入口**：TaskCenter → 团队 → 团队记忆。
 *
 * B 收口后没有 Bot 团队页签/群绑定；团队记忆直接挂在现有 AgentTeam 上，
 * 由用户显式写入；成员会话在系统提示里自动注入（服务层见 team-memory.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TeamTab } from "../components/task-center/TeamTab";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { setGlobalSubagentRuntime } from "../core/subagent/index";
import type { SubagentRuntime } from "../core/subagent/runtime";
import { AgentTeamsService } from "../core/provider/agent-teams-service";

function installRuntime(): void {
  let seq = 0;
  const runtime = {
    startContinuable: async () => {
      seq += 1;
      return { childId: `tm-ui-child-${seq}` };
    },
    getTask: () => undefined,
    followup: async () => undefined,
  };
  setGlobalSubagentRuntime(runtime as unknown as SubagentRuntime);
}

beforeEach(async () => {
  setStoragePort(createFakeStoragePort());
  AgentTeamsService._reset();
  installRuntime();
  const service = AgentTeamsService.getInstance();
  const team = service.create({ name: "面板团队", captainSessionId: "captain-panel-tm" });
  await service.addMember(team.id, { name: "面板成员", role: "执行", parentSessionId: "captain-panel-tm" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  setStoragePort(null);
  setGlobalSubagentRuntime(null);
  AgentTeamsService._reset();
  vi.restoreAllMocks();
});

describe("TaskCenter 团队页 · 团队记忆入口", () => {
  it("TM-UI-1：选团队 → 写 key/content → 落库 → 预览可见", async () => {
    render(<TeamTab />);
    await waitFor(() => expect(screen.getByTestId("team-memory-panel")).toBeTruthy());
    expect((screen.getByTestId("team-memory-team-select") as HTMLSelectElement).value).not.toBe("");

    fireEvent.change(screen.getByTestId("team-memory-key"), { target: { value: "release" } });
    fireEvent.change(screen.getByTestId("team-memory-content"), { target: { value: "周五 18:00 发布" } });
    fireEvent.click(screen.getByTestId("team-memory-save"));

    await waitFor(() =>
      expect(screen.getByTestId("team-memory-feedback").textContent).toContain("已写入"),
    );
    await waitFor(() => expect((screen.getByTestId("team-memory-preview") as HTMLTextAreaElement).value).toContain("周五 18:00 发布"));
  });
});
