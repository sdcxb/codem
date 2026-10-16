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
 *
 * ## 装配那一步的判据在另一个文件
 *
 * 第二次真机缺陷（插件"注册了"却从来没被装配）与平台条件（`when`）失效的判据
 * 在 `src/test/plugin-assembly-path.test.ts`（SO-6 / SO-8 / YW-1 / YW-2）——
 * 那是**清单与装配器**的缺陷，按主题分开放，别混在插件自身的行为判据里。
 *
 * 本文件守的是插件自身：默认开启（SO-1）、拒绝点名 5.1（SO-2/SO-4）、反向对照（SO-3）、
 * 服务契约（SO-5）、以及**默认设置项的落库时机**（SO-7）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getSetting } from "../core/storage/settings";
import { SHELL_OPS_ENABLED_KEY } from "../plugins/shell-ops/policy";

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
    const { resolveShellPlan } = await import("../plugins/shell-ops/policy");
    /**
     * 这里**不再**直接调 `mentionsWindowsPowerShell` / `mentionsPwsh7`：
     * 那两个谓词已降为模块内部（导出面收口，见 policy.ts 的说明），而且从行为上测更结实 ——
     * 下面每一条断言的都是"这条命令会不会在**执行之前**被拒"。
     */
    for (const cmd of [
      "echo a; powershell -c dir",
      "cd /c && powershell.exe -Command dir",
      "git status\npowershell -NoProfile -Command dir",
    ]) {
      expect(resolveShellPlan(cmd).refusal, `应拒绝：${cmd}`).toBeTruthy();
    }
    // 出口：`pwsh`（7）不算点名 5.1 —— 它必须**不被拒**
    const pwshPlan = resolveShellPlan("pwsh -NoProfile -Command 'Get-Process'");
    expect(pwshPlan.refusal, "pwsh（7）是允许的出口，不许被误判成 5.1").toBeUndefined();
    expect(pwshPlan.kind, "走 pwsh 的活儿也必须是 bash 分支交给 Rust 判定（不在这里换执行器）").toBe("bash");
  });

  it("SO-5: 服务契约由真装配后的服务本身给出：isEnabled / plan / describe 三项可用", async () => {
    /**
     * 装配后从 `ctx.get("shellOps")` 拿服务再验（而不是 import 一个内部构造函数）：
     * 断言的就是消费方（`tools.ts` 的 `getToolContext()?.get("shellOps")`）真正会拿到的东西。
     */
    await installPort({});
    const { Context } = await import("../core/cordis/src/index.ts");
    const { shellOpsProvider } = await import("../plugins/shell-ops/provider");
    const ctx = new Context();
    (ctx as any).plugin(shellOpsProvider as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const svc = (ctx as any).get("shellOps", false);
    expect(svc, "消费方按字面量 'shellOps' 取服务 —— 这个名字就是契约").toBeTruthy();
    expect(svc.isEnabled()).toBe(true);
    expect(svc.plan("git status").kind).toBe("bash");
    expect(svc.describe()).toMatch(/shell-ops/);
  });

  it("SO-7: apply 必须真的提供出服务；默认设置项必须在**存储就绪之后、真的要用插件时**才落", async () => {
    /**
     * 这一条把两个真机缺陷都钉住：
     *
     * ① **服务真的被提供了**（`ctx.get("shellOps")` 拿得到）—— 上一轮真机上完全没提供；
     * ② **默认设置项不许在装配时抢写** —— 装配发生在存储端口预热之前，那时写必失败
     *    （真机 console：`[PersistFailure] settings.setSetting 写盘失败…端口已注册但该域镜像未接手`），
     *    于是键永远不存在，每次启动还白报一次「设置未保存」。
     *
     * 假端口对"加载窗口"的唯一建模方式是 `asyncLoad: true`（见 fake-storage-port.ts 的说明：
     * 就绪时机相关的用例**必须**显式切到异步），所以这里用它 —— 静态端口看不见这个缺陷。
     */
    port = createFakeStoragePort({ asyncLoad: true, seed: { settings: [] } });
    setStoragePort(port);
    const { Context } = await import("../core/cordis/src/index.ts");
    const { shellOpsProvider } = await import("../plugins/shell-ops/provider");

    const ctx = new Context();
    (ctx as any).plugin(shellOpsProvider as any);
    // Cordis 的激活是异步的（fiber._reload 先 await Promise.resolve() 再 _execute）——
    // 让微任务/宏任务各跑一轮，再读服务（与 App.tsx 的 setTimeout(0) 同量级）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const svc = (ctx as any).get("shellOps", false);
    expect(svc, "装配后 ctx.get('shellOps') 必须拿得到 —— 这一环在真机上曾经是断的").toBeTruthy();
    expect(
      getSetting(SHELL_OPS_ENABLED_KEY),
      "装配时**不许**写设置：存储还没预热，这一笔在真机上必失败（改坏回装配置时这一条会红）",
    ).toBeNull();
    expect(svc.plan("powershell -Command \"dir\"").refusal, "拿到的服务必须真的在判定").toBeTruthy();

    // 模拟应用启动完成（存储预热就绪）
    await port.config.warmup();
    expect(svc.plan("git status").kind, "普通命令走 bash").toBe("bash");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      getSetting(SHELL_OPS_ENABLED_KEY),
      "存储就绪后，第一次真的要用插件时必须把默认值落库（真机上这个键曾经永远是 null）",
    ).not.toBeNull();
  });

});
