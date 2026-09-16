/**
 * 第 87 波（B 类：假成功）：把"catch 里只打一行日志"的写/动作路径接进统一上报通道。
 *
 * 背景：机器扫描发现全项目有 31 处"写/动作类函数"在 catch 里只 `console.warn/error`
 * 就继续往下走 —— 更新会话标题、删除项目、保存权限规则、导出设置、成本上限、
 * 恢复快照、worktree 创建/清理、委派工具注册、UI 插件加载……调用方与界面完全看不出失败：
 *   · `updateSession`：写库失败 → store 照常更新（用户以为保存成功，重启后回旧值）；
 *   · `createWorktree`：创建失败 → 静默回退到主工作区（用户以为在隔离分支里改代码）；
 *   · `saveCustomRules`：权限规则写不进去 → 用户以为加的"拒绝规则"生效了（安全相关）；
 *   · `setupDelegationTools`：工具注册失败 → 模型根本没有那些工具，只有一行 warn。
 *
 * 修复后统一走 `storage/persist-failure.ts`：error 级日志 + 计数 + 窗口事件
 * （App 侧转成一次性可见提示，同一区域不重复提示）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reportPersistFailure,
  reportActionFailure,
  getPersistFailures,
  hasPersistFailures,
  resetPersistFailures,
  setPersistFailureListener,
} from "../core/storage/persist-failure";

beforeEach(() => {
  resetPersistFailures();
  setPersistFailureListener(null);
  vi.restoreAllMocks();
});

describe("统一失败上报通道", () => {
  it("PF-1: 上报会记账、写 error 日志、派发窗口事件", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: any[] = [];
    const onEvent = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("codem:persist-failed", onEvent);

    const entry = reportPersistFailure("store.updateSession", new Error("disk full"), "标题未保存");
    window.removeEventListener("codem:persist-failed", onEvent);

    expect(entry.count).toBe(1);
    expect(entry.kind).toBe("persist");
    expect(hasPersistFailures()).toBe(true);
    expect(getPersistFailures()[0].area).toBe("store.updateSession");
    expect(err.mock.calls.flat().join(" ")).toMatch(/store\.updateSession 写盘失败/);
    expect(err.mock.calls.flat().join(" ")).toMatch(/标题未保存/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ area: "store.updateSession", kind: "persist", count: 1 });
    err.mockRestore();
  });

  it("PF-2: 同一区域重复失败只累计次数（不刷屏），并回调监听者", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: any[] = [];
    setPersistFailureListener((d) => seen.push(d));

    reportPersistFailure("recovery.save", new Error("e1"));
    reportPersistFailure("recovery.save", new Error("e2"));
    reportPersistFailure("mcp.saveConfigs", new Error("e3"));

    const list = getPersistFailures();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.area === "recovery.save")!.count).toBe(2);
    expect(list.find((x) => x.area === "recovery.save")!.lastMessage).toBe("e2");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ area: "mcp.saveConfigs", kind: "persist" });
    err.mockRestore();
  });

  it("PF-3: 动作失败用 action 类型（文案与语义区分于落盘失败）", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = reportActionFailure("store.createWorktree", new Error("git failed"), "已回退主工作区");
    expect(entry.kind).toBe("action");
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).toMatch(/操作失败/);
    expect(logged).toMatch(/该功能本次没有生效/);
    err.mockRestore();
  });

  it("PF-4（接线契约）: 关键写/动作路径必须走统一上报，而不是只打日志", () => {
    const fs = require("fs");
    const path = require("path");
    const mustWire: Array<[string, string]> = [
      ["src/core/store.ts", "store.updateSession"],
      ["src/core/store.ts", "store.deleteProject"],
      ["src/core/store.ts", "store.createWorktree"],
      ["src/core/store.ts", "store.removeWorktree"],
      ["src/core/session/delegation-storage.ts", "delegation.createDelegationTask"],
      ["src/core/recovery/recovery.ts", "recovery.save"],
      ["src/core/permission/permission.ts", "permission.saveCustomRules"],
      ["src/core/settings/settings.ts", "settings.saveFile"],
      ["src/core/llm/cost-tracker.ts", "costTracker.setLimits"],
      ["src/core/llm/model-profile.ts", "modelProfile.save"],
      ["src/core/llm/index.ts", "delegationTools.agentTeams"],
      ["src/core/llm/index.ts", "delegationTools.computerUse"],
      ["src/core/mcp/mcp.ts", "mcp.saveConfigs"],
      ["src/core/ui-plugins/index.ts", "uiPlugins.load"],
      ["src/core/storage/sync-engine.ts", "syncEngine.autoSync"],
      ["src/core/knowledge/note-manager.ts", "noteManager.deleteNoteLinksBySource"],
    ];
    for (const [rel, area] of mustWire) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
      expect(src.includes(area), `${rel} 应上报 ${area}`).toBe(true);
    }
  });
});
