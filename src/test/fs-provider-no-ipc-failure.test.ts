/**
 * `@vitest-environment node`
 *
 * FSW-2（真实腿）：**在没有 IPC 通道的宿主里**，`fs-provider.glob` 必须**抛错**。
 *
 * ## 为什么单独一个文件、而且专门用 node 环境
 *
 * ① `test/fs-provider-invoke-surface.test.ts` 用 `vi.mock` 换掉 `file-api`（为了量参数与形状），
 *    那条腿证明不了"真实 `file-api` → 真实 `tauriInvoke`"这一段；
 * ② node 环境里 `window` **根本不存在** —— 这正是"拿不到 invoke"的极端形态。改前
 *    `glob` 的实现是 `const { invoke } = (window as any).__TAURI__?.core || {}`：
 *    `window` 未定义时它**自己就抛**（`ReferenceError`），但**不带任何可诊断信息**；
 *    而真机上 `window` 存在、只是没有 `__TAURI__`（浏览器/测试宿主）时，它**静默 `return []`**
 *    —— 本文件把两种形态都钉住：**必须是抛错，且错误信息要说得出"通道不可用"**。
 *
 * 判据名：`FSW-2-real`。
 */
import { describe, it, expect } from "vitest";
import { fsProvider } from "../core/provider/fs-provider";

function loadFsService() {
  let service: any;
  const ctx = { provide: (_n: string, v: any) => { service = v; return () => {}; } };
  fsProvider(ctx);
  if (!service) throw new Error("fsProvider 没有 provide('fs')");
  return service;
}

describe("FSW-2-real: 真实 file-api 腿 —— 没有 IPC 通道就是抛错", () => {
  it("FSW-2-real-1: 宿主里没有 window（更没有 __TAURI__）⇒ glob 抛错，绝不返回 []", async () => {
    expect(typeof window, "本文件跑在 node 环境：window 必须不存在，否则这条判据就失去意义").toBe("undefined");
    const svc = loadFsService();
    // ★ `rejects.toThrow` 本身就是"抛错"的形状断言：若它返回 `[]`（静默降级）这条必红。
    await expect(svc.glob("*.ts")).rejects.toThrow(/__TAURI__|invoke|window|Tauri/i);
  });

  it("FSW-2-real-2: 同一个宿主里 grep 同样抛错（不是 []）", async () => {
    const svc = loadFsService();
    await expect(svc.grep("needle")).rejects.toThrow();
  });

  it("FSW-2-real-3: 同一宿主里 deleteFile 抛错，且错误说明删除未执行", async () => {
    const svc = loadFsService();
    await expect(svc.deleteFile("C:/ws/x.ts")).rejects.toThrow(/删除未执行|invoke|__TAURI__/);
  });

  it("FSW-2-real-4: 反向对照 —— 真实 file-api 的 glob_search 腿也没被谁吞掉", async () => {
    // 直接量真实 globSearch：它必须抛（而不是自己 catch 成空结果）。
    const { globSearch } = await import("../core/file-api");
    await expect(globSearch("*.ts", "C:/ws", { workspace: "C:/ws" })).rejects.toThrow();
  });
});
