/**
 * 第 16 轮：服务级可达性门禁。
 *
 * 背景：`@codem/sandbox-policy` 这类插件「注册了、装配了、日志也打了」，但没有任何
 * `get('sandboxPolicy')` —— 文件级可达性门禁看不到，单测又直接调 API，于是活了十几个版本。
 * 这组判据守两件事：
 *   ① 沙箱死骨架删掉后，不许以任何形式回到 `provide 无 get` 的基线里；
 *   ② 扫描器本身要能区分「真消费」与「只是 inject / 只在注册表里出现」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDeadServices, scan } from "../../tools/audit/scan-unconsumed-services.mjs";

const ROOT = process.cwd();
const SANDBOX_SERVICES = [
  "sandbox",
  "sandboxPolicy",
  "bashSandbox",
  "fsSandbox",
  "pwshSandbox",
  "sandboxWindowsAcl",
];

describe("SERVICE-16：provide 了必须有人 get", () => {
  it("沙箱死服务不许回到全仓死服务清单里", () => {
    const dead = scan().map((d: { service: string }) => d.service);
    for (const svc of SANDBOX_SERVICES) {
      expect(dead, `${svc} 又被提供了却没人读 ⇒ 应删除或补消费方`).not.toContain(svc);
    }
  });

  it("扫描器：provide 无 get ⇒ dead；有 get ⇒ 不算；注册表/市场里的引用不算消费", () => {
    const files = new Map<string, string>([
      ["src/core/provider/a-provider.ts", "ctx.provide('liveService', {})"],
      ["src/core/llm/consumer.ts", "const x = ctx.get('liveService')"],
      ["src/core/provider/b-provider.ts", "ctx.provide('deadService', {})"],
      // 注册表里的字符串不算消费方（否则死代码会被自己的登记表救活）
      ["src/core/plugin-loader/builtin-registry.ts", "registerBuiltinPlugin('deadService', {})"],
      // inject 也不等于消费
      ["src/core/provider/c-provider.ts", "export const p = (ctx) => ctx.provide('injectOnly', {})"],
      ["config/codem.base.yml", "inject: [injectOnly]"],
    ]);
    const dead = findDeadServices(files).map((d: { service: string }) => d.service);
    expect(dead).toContain("deadService");
    expect(dead).toContain("injectOnly");
    expect(dead).not.toContain("liveService");
  });

  it("基线覆盖当前全仓死服务（新增死服务必须先登记或补消费方）", () => {
    const baseline = JSON.parse(
      readFileSync(join(ROOT, "tools/audit/unconsumed-services-baseline.json"), "utf8"),
    ) as { services: Record<string, unknown> };
    const baselineNames = new Set(Object.keys(baseline.services));
    const added = scan()
      .map((d: { service: string }) => d.service)
      .filter((name: string) => !baselineNames.has(name));
    expect(added, "新增 dead service 未登记基线").toEqual([]);
  });
});
