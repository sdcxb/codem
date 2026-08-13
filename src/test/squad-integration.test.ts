/**
 * Squad 集成测试 — 验证 SquadManager 基础功能
 *
 * 由于 browser 环境下 DB 不可用，这些测试主要验证类型正确性和
 * 非依赖 DB 的逻辑（如 roster 生成格式）。
 */

import { describe, it, expect } from "vitest";

describe("Squad 工具定义", () => {
  it("squad_list 工具 — schema 正确", async () => {
    const { createSquadListTool } = await import("../core/squad/squad-tools");
    const tool = createSquadListTool();
    expect(tool.id).toBe("squad_list");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeTypeOf("function");
  });

  it("squad_dispatch 工具 — schema 正确，必填参数齐全", async () => {
    const { createSquadDispatchTool } = await import("../core/squad/squad-tools");
    const tool = createSquadDispatchTool();
    expect(tool.id).toBe("squad_dispatch");
    expect(tool.parameters).toBeDefined();
    const params = tool.parameters as any;
    expect(params.properties.squad_id).toBeDefined();
    expect(params.properties.task).toBeDefined();
    expect(params.required).toContain("squad_id");
    expect(params.required).toContain("task");
  });

  it("squad_status 工具 — schema 正确，必填参数齐全", async () => {
    const { createSquadStatusTool } = await import("../core/squad/squad-tools");
    const tool = createSquadStatusTool();
    expect(tool.id).toBe("squad_status");
    expect(tool.parameters).toBeDefined();
    const params = tool.parameters as any;
    expect(params.properties.squad_id).toBeDefined();
    expect(params.required).toContain("squad_id");
  });
});

describe("Squad 类型完整性", () => {
  it("SquadManager — getSquadManager 返回单例", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    const mgr1 = getSquadManager();
    const mgr2 = getSquadManager();
    expect(mgr1).toBe(mgr2);
  });

  it("SquadManager — generateSquadRoster 对不存在的 squad 返回 null", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    const mgr = getSquadManager();
    const roster = mgr.generateSquadRoster("nonexistent-squad-id");
    expect(roster).toBeNull();
  });

  it("SquadManager — listSquads 返回数组", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    const mgr = getSquadManager();
    const squads = mgr.listSquads();
    expect(Array.isArray(squads)).toBe(true);
  });

  it("SquadManager — onSquadChange 返回 unsubscribe 函数", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    const mgr = getSquadManager();
    const unsub = mgr.onSquadChange(() => {});
    expect(unsub).toBeTypeOf("function");
    unsub();
  });
});

describe("Squad DB Schema", () => {
  it(" squads 和 squad_members 表在 SCHEMA 中定义", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dbSource = fs.readFileSync(
      path.join(__dirname, "../core/storage/database.ts"),
      "utf-8",
    );
    expect(dbSource).toContain("CREATE TABLE IF NOT EXISTS squads");
    expect(dbSource).toContain("CREATE TABLE IF NOT EXISTS squad_members");
    expect(dbSource).toContain("idx_squad_members_squad");
  });
});

describe("DelegationTask 类型扩展", () => {
  it("DelegationTask 包含可选 squadId 和 memberId 字段", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const typesSource = fs.readFileSync(
      path.join(__dirname, "../core/session/types.ts"),
      "utf-8",
    );
    expect(typesSource).toContain("squadId?");
    expect(typesSource).toContain("memberId?");
  });
});

describe("Prompt 系统提示词支持 squadRoster", () => {
  it("SystemPromptConfig 包含 squadRoster 字段", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const promptSource = fs.readFileSync(
      path.join(__dirname, "../core/prompt/prompt.ts"),
      "utf-8",
    );
    expect(promptSource).toContain("squadRoster");
  });
});

describe("CostTracker 支持 squad 成本汇总", () => {
  it("getSquadCost 方法存在", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const costSource = fs.readFileSync(
      path.join(__dirname, "../core/llm/cost-tracker.ts"),
      "utf-8",
    );
    expect(costSource).toContain("getSquadCost");
  });
});

describe("Worktree 限额已调整", () => {
  it("maxWorktrees 默认值为 30", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const wtSource = fs.readFileSync(
      path.join(__dirname, "../core/environment/worktree-manager.ts"),
      "utf-8",
    );
    expect(wtSource).toContain("maxWorktrees: 30");
  });
});

describe("Squad 工具已在 LLMEngine 中注册", () => {
  it("LLMEngine.setupDelegationTools 包含 squad 工具注册", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const engineSource = fs.readFileSync(
      path.join(__dirname, "../core/llm/index.ts"),
      "utf-8",
    );
    expect(engineSource).toContain("createSquadListTool");
    expect(engineSource).toContain("createSquadDispatchTool");
    expect(engineSource).toContain("createSquadStatusTool");
  });
});

describe("App.tsx 包含 Squad 路由", () => {
  it("App.tsx 监听 codem-squad-dispatch 事件", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const appSource = fs.readFileSync(
      path.join(__dirname, "../App.tsx"),
      "utf-8",
    );
    expect(appSource).toContain("codem-squad-dispatch");
    expect(appSource).toContain("handleSquadDispatch");
  });
});
