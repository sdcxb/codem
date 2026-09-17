/**
 * `ctx.uiPermissionPresets` 必须只是**真实安全模式系统的一层视图**
 * （第 45 轮功能上下文审计 P1-2 / P3）。
 *
 * ## 原来是什么样（一套平行且不生效的权限系统）
 *
 * 该服务自带"严格 / 标准 / 宽松"预设与一套规则（`autoApproveRead` / `autoApproveShell` /
 * `blockedPaths` …），暴露 `shouldAutoApprove()` / `isPathBlocked()`。这些规则在全仓
 * **零读取者**：真正管权限的是 `security-mode.ts`（`ask|auto|full`）→ `agentic-loop`/ToolPipeline。
 * 于是：
 * - `selectPreset('permissive')` 只改本地字段 → 应用的安全姿态**一点没变**；
 * - `isPathBlocked('**')` 在"严格"下**声称**全拦住了 → 实际一条都没拦。
 * 用户据它做安全判断会得到与事实相反的结论 —— 这是本轮最不能留的一类形态。
 *
 * 这条用例钉住修好后的契约：**词表来自真系统、切换真的生效、监听的是真实变更事件、
 * 假执行/假拦截/假注册不复存在**。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { getGlobalSecurityMode, setGlobalSecurityMode } from "../core/permission/security-mode";

async function service(): Promise<{ api: any; dispose: () => void }> {
  const { uiPermissionPresetsProvider } = await import("../core/provider/ui-permission-presets-provider");
  let captured: any = null;
  const registered: string[] = [];
  const ctx = {
    provide: (_name: string, api: any) => {
      captured = api;
      return () => {};
    },
    get: (name: string) => {
      if (name !== "slots") return undefined;
      return {
        register: () => () => {},
        inject: () => () => {},
      };
    },
  };
  const dispose = (uiPermissionPresetsProvider as unknown as (c: unknown) => () => void)(ctx);
  expect(captured, "provider 必须注册出 uiPermissionPresets 服务").toBeTruthy();
  return { api: captured, dispose: dispose ?? (() => {}) };
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as unknown as StoragePort);
  setGlobalSecurityMode("ask");
});

describe("uiPermissionPresets：从「平行不生效的预设」改成真实视图", () => {
  it("UPP-1: 词表必须来自真系统（ask/auto/full），不再有「严格/标准/宽松」那套", async () => {
    const { api } = await service();
    const ids = api.listPresets().map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(["ask", "auto", "full"]);
    expect(api.getPreset("permissive"), "旧词表的取值不应再被认得").toBeUndefined();
    expect(api.getCurrentPreset().id, "当前预设必须是真系统的当前模式").toBe("ask");
  });

  it("UPP-2: `selectPreset` 必须**真的**改变应用的安全姿态（不只是改本地字段）", async () => {
    const { api } = await service();
    api.selectPreset("full");
    expect(getGlobalSecurityMode(), "必须落到真系统上（与设置页同一个开关）").toBe("full");
    expect(api.getCurrentPreset().id).toBe("full");
  });

  it("UPP-3: 非法预设必须显式抛错，且不许改动当前模式", async () => {
    const { api } = await service();
    expect(() => api.selectPreset("permissive"), "旧词表的值必须被拒绝").toThrow(/未知的权限预设/);
    expect(getGlobalSecurityMode()).toBe("ask");
  });

  it("UPP-4: `subscribe` 监听的是**真实变更事件**（别人改了模式也要通知到）", async () => {
    const { api } = await service();
    const seen: string[] = [];
    const off = api.subscribe((mode: string) => seen.push(mode));

    // 模拟"别处"（设置页 / App）改了模式 —— 服务自己没有参与这次调用
    setGlobalSecurityMode("auto");
    expect(seen, "真实变更必须转达给订阅者（原来只有自己 selectPreset 才会通知）").toContain("auto");

    off();
    setGlobalSecurityMode("full");
    expect(seen, "退订之后不再收到").not.toContain("full");
  });

  it("UPP-5: 假执行 / 假拦截 / 假注册都不许再暴露", async () => {
    const { api } = await service();
    expect(api.shouldAutoApprove, "没有读取者的「自动批准判定」只会让人以为它在生效").toBeUndefined();
    expect(api.isPathBlocked, "假拦截最危险：声称拦住了一条都没拦").toBeUndefined();
    expect(api.registerPreset, "真系统不支持注册自定义模式").toBeUndefined();
  });
});
