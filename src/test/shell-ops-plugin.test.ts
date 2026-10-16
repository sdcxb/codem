/**
 * `@codem/shell-ops` 插件判据（Codem 插件机制 + shell 路由策略）。
 *
 * ## 守的缺陷（真机）
 * `bash` 工具在 Windows 上实际跑的是 Windows PowerShell 5.1（`lib.rs` 写死 `Command::new("powershell")`）：
 * `&&` 语法错误、`Set-Content -Encoding UTF8` 写 BOM（炸 JSON 解析）、单元素数组转 JSON 降级……
 * 每次报错都变成一轮"读错误 → 改写 → 再试"。
 *
 * ## 两条纪律（用户要求）
 * 1. **默认开启**：设置缺失时即视为启用（SO-1）；
 * 2. **绕不开**：启用期间点名 `powershell` 的命令在**执行之前**被拒（SO-2/SO-4）——
 *    这是结构约束，不依赖提示词；关掉插件后必须能回到旧行为（SO-3，反向对照）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

let port: FakeStoragePort;

async function installPort(settings: Record<string, unknown>) {
  port = createFakeStoragePort({
    seed: { settings: Object.entries(settings).map(([key, value]) => ({ key, value: JSON.stringify(value) })) },
  });
  await port.config.warmup();
  setStoragePort(port);
}

beforeEach(() => setStoragePort(null));
afterEach(() => setStoragePort(null));

describe("SHELL-OPS：默认开启 + 硬锁 PowerShell", () => {
  it("SO-1: 设置缺失时插件默认**开**，且普通命令走 bash", async () => {
    await installPort({});
    const { isShellOpsEnabled, resolveShellPlan } = await import("../plugins/shell-ops/policy");
    expect(isShellOpsEnabled(), "默认必须开（用户要求默认开启）").toBe(true);
    const plan = resolveShellPlan("git status && npx vitest run");
    expect(plan.kind, "启用期间普通命令必须走 bash").toBe("bash");
    expect(plan.refusal, "普通命令不该被拒").toBeUndefined();
  });

  it("SO-2: 启用期间点名 `powershell` 的命令必须被**拒绝**（并把 PowerShell 7 出口给出来）", async () => {
    await installPort({});
    const { resolveShellPlan } = await import("../plugins/shell-ops/policy");
    const plan = resolveShellPlan("powershell -Command \"Get-ChildItem C:\\\"");
    expect(plan.refusal, "点名 5.1 必须被拒 —— 否则模型还能绕回去").toBeTruthy();
    expect(plan.refusal).toMatch(/powershell\.exe|pwsh/);
  });

  it("SO-3: 反向对照 —— 关掉插件后必须回到旧行为（powershell），不许把判据做成哑巴全拦", async () => {
    await installPort({ "codem-shell-ops-enabled": false });
    const { isShellOpsEnabled, resolveShellPlan } = await import("../plugins/shell-ops/policy");
    expect(isShellOpsEnabled()).toBe(false);
    const plan = resolveShellPlan("powershell -Command \"dir\"");
    expect(plan.kind, "关掉插件后命令交回 PowerShell").toBe("powershell");
    expect(plan.refusal, "关掉插件后不许再拦").toBeUndefined();
  });

  it("SO-4: 命令词识别要覆盖 `;` / `&&` / 换行后的 powershell；`pwsh` 不算（这是留的出口）", async () => {
    await installPort({});
    const { resolveShellPlan, mentionsWindowsPowerShell, mentionsPwsh7 } = await import("../plugins/shell-ops/policy");
    for (const cmd of [
      "echo a; powershell -c dir",
      "cd /c && powershell.exe -Command dir",
      "git status\npowershell -NoProfile -Command dir",
    ]) {
      expect(mentionsWindowsPowerShell(cmd), cmd).toBe(true);
      expect(resolveShellPlan(cmd).refusal, `应拒绝：${cmd}`).toBeTruthy();
    }
    expect(mentionsPwsh7("pwsh -NoProfile -Command 'Get-Process'"), "pwsh（7）是允许的出口").toBe(true);
    expect(mentionsWindowsPowerShell("pwsh -NoProfile -Command 'Get-Process'"), "pwsh 不能被误判成 5.1").toBe(false);
  });

  it("SO-5: 服务按 Codem 插件机制提供（provider 契约）：plan/describe/isEnabled 三项可用", async () => {
    await installPort({});
    const { createShellOpsService, SHELL_OPS_SERVICE } = await import("../plugins/shell-ops/provider");
    expect(SHELL_OPS_SERVICE).toBe("shellOps");
    const svc = createShellOpsService();
    expect(svc.isEnabled()).toBe(true);
    expect(svc.plan("git status").kind).toBe("bash");
    expect(svc.describe()).toMatch(/shell-ops/);
  });

  it("SO-6: 插件必须接进**真正会 apply 的入口**（只写 builtin-registry 不会提供任何服务）", () => {
    /**
     * 真机验证抓到的缺陷：`registerBuiltinPlugins()` 只把插件写进注册表
     * （插件管理器与可达性门禁因此都看得到），但**真正 apply provider 的是
     * `loadDefaultProviders(ctx)`**（src/core/provider/index.ts）。少了这一步：
     * 服务从没被提供 ⇒ 执行层 `get('shellOps')` 拿不到 ⇒ 静默回退 PowerShell
     * （真机日志里没有 `exec shell=bash`、界面报 PowerShell 语法错，而单测全绿）。
     */
    const providerIndex = fs.readFileSync(path.join(ROOT, "src/core/provider/index.ts"), "utf8");
    expect(providerIndex, "必须 import 插件 provider").toContain("shellOpsProvider");
    expect(providerIndex, "必须出现在 loadDefaultProviders 的列表里").toMatch(
      /{ name: 'shellOps', plugin: shellOpsProvider }/,
    );
    const registry = fs.readFileSync(path.join(ROOT, "src/core/plugin-loader/builtin-registry.ts"), "utf8");
    expect(registry, "注册表里也要有（插件管理器启停用）").toContain("'@codem/shell-ops'");
  });
});
