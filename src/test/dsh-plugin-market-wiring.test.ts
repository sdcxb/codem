/**
 * dsh 插件市场装配一致性测试
 *
 * PM-1 codem.base.yml 的 dsh-compat 行与 builtin-registry 注册名一致（防断链）
 * PM-2 runtimePluginList 含 @codem/dsh-compat（插件管理可见/可开关）
 * PM-3 builtin-registry 注册的 @codem/dsh-compat provides 别名齐全
 * PM-4 runtimePluginList 与 builtinPlugins 同名条目元数据一致（防 provides/inject/category
 *      漂移——曾发生 dsh-compat 在清单里写成 dshLLM/dshFS 大写 4 别名，依赖图与实际
 *      Cordis 服务错位：依赖 dshSessions 的插件被误判缺依赖、UI 徽章展示错误）
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const { runtimePluginList } = await import("../core/provider/plugin-registry-provider");
const registryNames = new Set((runtimePluginList as any[]).map((p: any) => p.name));
const { registerBuiltinPlugins } = await import("../core/plugin-loader/builtin-registry");
const { builtinPlugins } = await import("../core/plugin-loader/index");

describe("dsh 插件市场装配一致性", () => {
  it("PM-1: codem.base.yml 声明 dsh-compat 且 builtin-registry 已注册同名插件", () => {
    const yml = fs.readFileSync(path.join(process.cwd(), "config", "codem.base.yml"), "utf8");
    expect(yml).toContain("name: '@codem/dsh-compat'");
    // builtin 注册表源码包含注册调用（防 YAML 引用了已删插件——历史教训 terminal-bash）
    const registrySrc = fs.readFileSync(
      path.join(process.cwd(), "src", "core", "plugin-loader", "builtin-registry.ts"),
      "utf8",
    );
    expect(registrySrc).toContain("'@codem/dsh-compat'");
    expect(registrySrc).toContain("dshCompatPlugin");
  });

  it("PM-2: runtimePluginList 含 @codem/dsh-compat（插件管理市场安装对象可见）", () => {
    expect(registryNames.has("@codem/dsh-compat")).toBe(true);
  });

  it("PM-3: builtin 注册 provides 覆盖 7 个别名服务", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "core", "plugin-loader", "builtin-registry.ts"),
      "utf8",
    );
    // 找到 dsh-compat 注册行并断言别名齐全
    const line = src.split("\n").find((l) => l.includes("@codem/dsh-compat") && l.includes("provides"));
    expect(line).toBeTruthy();
    for (const alias of ["dshLlm", "dshShell", "dshFs", "dshTools", "dshSessions", "dshEvents", "dshCredentials"]) {
      expect(line).toContain(alias);
    }
  });

  it("PM-5: 插件管理入口支撑插件（plugin-registry/ui-slots）标记 core 保护（防禁用死锁）", () => {
    // 死锁场景：pluginMgrEnabled = !disabled(plugin-registry) && !disabled(ui-slots)，
    // 若两者可禁用 → 插件管理按钮消失且无入口恢复。必须 core 保护（disable 被 lock 拒绝）。
    for (const name of ["@codem/plugin-registry", "@codem/ui-slots"]) {
      const meta = (runtimePluginList as any[]).find((p: any) => p.name === name);
      expect(meta, `${name} 应存在于 runtimePluginList`).toBeTruthy();
      expect(meta.core, `${name} 必须 core:true（可禁用会造成插件管理入口死锁）`).toBe(true);
    }
    // builtin 注册侧同样保护（apply 同步会以 builtin 为准）
    registerBuiltinPlugins();
    for (const name of ["@codem/plugin-registry", "@codem/ui-slots"]) {
      const reg = builtinPlugins.get(name);
      expect(reg?.meta.core, `${name} builtin 注册应 core:true`).toBe(true);
    }
  });

  it("PM-4: pluginRegistryProvider.apply 后 runtimePluginList 与 builtinPlugins 拓扑一致（防 drift）", async () => {
    // 真实装配：注册 builtin → 激活 pluginRegistryProvider（apply 内做拓扑同步）
    registerBuiltinPlugins();
    const { Context } = await import("../core/cordis/src/index.ts");
    const { pluginRegistryProvider } = await import("../core/provider/plugin-registry-provider");
    const ctx = new Context();
    await ctx.plugin(pluginRegistryProvider as any);

    let compared = 0;
    for (const meta of runtimePluginList as any[]) {
      const reg = builtinPlugins.get(meta.name);
      if (!reg) continue; // 仅对比两边都存在的插件
      compared++;
      const sort = (a?: string[]) => [...(a || [])].sort().join(",");
      expect(sort(meta.provides), `${meta.name} provides 应与 builtin 注册一致（apply 同步后）`).toBe(sort(reg.meta.provides));
      expect(sort(meta.inject), `${meta.name} inject 应与 builtin 注册一致（apply 同步后）`).toBe(sort(reg.meta.inject));
    }
    expect(compared).toBeGreaterThan(100); // 全量覆盖

    // 特判 dsh-compat：7 个小写驼峰别名齐全，无大写变体残留
    const compat = (runtimePluginList as any[]).find((p: any) => p.name === "@codem/dsh-compat");
    expect(compat).toBeTruthy();
    for (const alias of ["dshLlm", "dshShell", "dshFs", "dshTools", "dshSessions", "dshEvents", "dshCredentials"]) {
      expect(compat.provides.includes(alias), `${alias} 应在 runtimePluginList provides`).toBe(true);
    }
    const prov = compat.provides.join(",");
    expect(prov.includes("dshLLM") || prov.includes("dshFS"), "不得退回大写变体 dshLLM/dshFS").toBe(false);
  });
});
