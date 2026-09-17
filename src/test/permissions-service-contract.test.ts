/**
 * `ctx.permissions` 服务必须暴露**真实能力**（第 45 轮功能上下文审计 P4）。
 *
 * ## 原来是什么样
 *
 * `permissions-provider.ts`（带 `// @ts-nocheck`，所以 TS 一处都没报）把三个**不存在**的方法
 * 转发给了真实的 `PermissionManager`：
 *
 * | 暴露的方法 | 真实 `PermissionManager` 上 |
 * | --- | --- |
 * | `check(tool, args, mode)` → `manager.checkPermission(...)` | **没有这个方法** → `TypeError` |
 * | `setMode(name)` → `manager.setSecurityMode(name)` | **没有** → `TypeError` |
 * | `getActiveMode()` → `manager.getActiveSecurityMode()` | **没有** → `TypeError` |
 *
 * 另外 `listModes()` 返回的是**第三套词表**（`ask/auto-approve/strict`，来自
 * `permission.ts::getSecurityModes`），而全应用真正在用的是 `ask/auto/full`
 * （`security-mode.ts`）；`registerMode()` 更是"收下参数、什么都不做"的假能力。
 *
 * 这条用例从**行为**上钉住修好后的契约：能调、语义与真系统一致、非法输入**显式抛错**、
 * 假能力**不复存在**。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { getGlobalSecurityMode, setGlobalSecurityMode } from "../core/permission/security-mode";

/** 把 provider 注册出来的服务抓出来（`ctx.provide(name, api)` 返回 dispose） */
async function service(): Promise<any> {
  const { permissionsProvider } = await import("../core/provider/permissions-provider");
  let captured: any = null;
  const ctx = {
    provide: (_name: string, api: any) => {
      captured = api;
      return () => {};
    },
  };
  permissionsProvider(ctx as never);
  expect(captured, "provider 必须注册出 permissions 服务").toBeTruthy();
  return captured;
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as unknown as StoragePort);
  setGlobalSecurityMode("ask");
});

describe("ctx.permissions：从「说谎的 API」改成真实能力", () => {
  it("PERM-1: `check` 必须能调（原来必抛 TypeError）且返回真实判定", async () => {
    const p = await service();
    setGlobalSecurityMode("full");

    const r = p.check("read", { path: "a.txt" });
    expect(r, "check 必须返回结果而不是抛异常").toBeTruthy();
    expect(["allow", "ask", "deny"], "action 必须是真实判定词表").toContain(r.action);
    expect(r.action, "完全访问模式下读操作应当放行").toBe("allow");
    expect(r.allowed).toBe(true);
  });

  it("PERM-2: 危险命令在「替我审批」模式下**不许**放行（安全语义不能因为换一层包装而丢）", async () => {
    const p = await service();
    setGlobalSecurityMode("auto");

    const dangerous = p.check("bash", { command: "rm -rf / --no-preserve-root" });
    expect(dangerous.allowed, "危险命令在 auto 模式下必须仍然要确认/拒绝").toBe(false);
    expect(dangerous.action).not.toBe("allow");
  });

  it("PERM-3: `setMode` / `getActiveMode` 必须真的作用于**全应用那套**安全模式", async () => {
    const p = await service();

    expect(p.setMode("full")).toBe(true);
    expect(p.getActiveMode(), "读回的必须是真系统的当前值").toBe("full");
    expect(getGlobalSecurityMode(), "必须真的写进真系统（而不是写进某个本地数组）").toBe("full");
  });

  it("PERM-4: 非法模式必须**显式抛错**（静默忽略会让\"我设过了\"变成假记忆）", async () => {
    const p = await service();
    expect(() => p.setMode("nonsense")).toThrow(/未知的安全模式/);
    expect(() => p.setMode("auto-approve"), "旧词表里的值也不许被悄悄接受").toThrow();
    expect(getGlobalSecurityMode(), "抛错之后当前模式不许被改").toBe("ask");
  });

  it("PERM-5: `listModes` 必须是真系统那套词表（不是第三套）", async () => {
    const p = await service();
    const names = p.listModes().map((m: { name: string }) => m.name).sort();
    expect(names, "词表必须与 security-mode.ts 一致").toEqual(["ask", "auto", "full"]);
    expect(names).not.toContain("auto-approve");
    expect(names).not.toContain("strict");
    expect(p.getMode("full"), "getMode 也要认得真词表里的值").toBeTruthy();
    expect(p.getMode("strict"), "旧词表的取值不再被认得").toBeUndefined();
  });

  it("PERM-6: 假能力 `registerMode` 不许再暴露（收了参数却什么都不做比没有更糟）", async () => {
    const p = await service();
    expect(
      p.registerMode,
      "真系统不支持注册自定义安全模式：留着一个空实现会让调用方以为注册成功了",
    ).toBeUndefined();
  });
});
