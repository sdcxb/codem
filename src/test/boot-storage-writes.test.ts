/**
 * **启动期不许写存储**判据（2026-10-16）。
 *
 * ## 守的缺陷
 *
 * `@codem/shell-ops` 的默认设置项原来在**插件 apply 时**写：
 *
 * ```text
 * [PersistFailure] settings.setSetting 写盘失败（第 1 次）：
 * 端口已注册但该域镜像未接手（未就绪 / 未镜像 / 被逐出）（设置未保存）
 * ```
 *
 * 装配发生在存储端口**预热之前**，那一笔写必失败（`RustDataPort.setConfirmed` 对未预热的
 * 端口明确"不写、返回 false"，以免用空表覆盖已有内容）⇒ 每次启动都报一次「设置未保存」，
 * 而那个键**永远不存在**（"插件确实跑过"在设置面上就没有任何证据）。
 *
 * 这类缺陷只在"加载窗口"里出现 —— **静态端口看不见它**，
 * 所以判据必须显式用 `asyncLoad: true` / `settingsWarmed: false` 造出未预热状态。
 *
 * ## 判据
 * | # | 行为 |
 * |---|---|
 * | BOOT-1 | 未预热状态下装配"会写设置的 provider"，**写尝试次数必须为 0**（含反向对照：桩插件在 apply 期写 ⇒ 计数必须 ≥1） |
 * | BOOT-2 | 预热后写入必须真的生效（否则"不写"就变成"永远不写"—— 把缺陷修成另一种缺陷） |
 * | BOOT-3 | 静态全量：`src/core/provider/**` 与 `src/plugins/**` 里凡是调用设置写入函数的模块，必须逐条分类（时机可核对） |
 */
import { describe, expect, it, afterEach } from "vitest";
import { Context } from "../core/cordis/src/index.ts";
import { setStoragePort } from "../core/storage/port";
import { getSetting } from "../core/storage/settings";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { credentialsProvider } from "../core/provider/credentials-provider";
import { plansProvider } from "../core/provider/plans-provider";
import { presetProvider } from "../core/provider/preset-provider";
import { shellOpsProvider } from "../plugins/shell-ops/provider";
import { SHELL_OPS_ENABLED_KEY } from "../plugins/shell-ops/policy";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

/** 会把设置写进**设置端口**（Rust 侧 settings 域）的 provider —— 启动期风险面。 */
const WRITING_PROVIDERS: Array<{ name: string; plugin: any }> = [
  { name: "credentials", plugin: credentialsProvider },
  { name: "plans", plugin: plansProvider },
  { name: "preset", plugin: presetProvider },
  { name: "shellOps", plugin: shellOpsProvider },
];

function unwarmedPort(): FakeStoragePort {
  return createFakeStoragePort({ asyncLoad: true, settingsWarmed: false, seed: { settings: [] } });
}

async function applyAll(plugins: Array<{ name: string; plugin: any }>, port: FakeStoragePort) {
  const ctx = new Context();
  for (const { plugin } of plugins) (ctx as any).plugin(plugin);
  // Cordis 的激活是异步的（fiber._reload 先 await Promise.resolve() 再 _execute）
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  return ctx;
}

afterEach(() => setStoragePort(null));

describe("启动期不许写存储（加载窗口）", () => {
  it("BOOT-1: 未预热状态下装配这些 provider，写尝试次数必须是 0", async () => {
    const port = unwarmedPort();
    setStoragePort(port);
    expect(port.config.stats().warmed, "前置条件：端口必须处于未预热状态").toBe(false);

    await applyAll(WRITING_PROVIDERS, port);

    const stats = port.config.stats();
    expect(
      stats.blockedWrites,
      `未预热时的写入尝试次数=${stats.blockedWrites}（必须 0）。` +
        "apply 发生在存储预热之前 —— 这里写必然失败（真机上是每次都报「设置未保存」且键永远不存在）。" +
        "要落默认值请挪到「真的要用它」的时刻（例如第一次判定/第一次调用），并用确认式写入。",
    ).toBe(0);
  });

  it("BOOT-1 反向对照：仪器有效 —— 一个在 apply 期写的桩插件必须被抓到", async () => {
    const port = unwarmedPort();
    setStoragePort(port);

    const { setSetting } = await import("../core/storage/settings");
    const evil = () => {
      // 故意在 apply 期抢写（这正是被修掉的那个形状）
      setSetting("boot-probe-key", "1");
      return () => {};
    };

    await applyAll([{ name: "boot-probe", plugin: evil as any }], port);

    expect(
      port.config.stats().blockedWrites,
      "桩插件在 apply 期写了一次 ⇒ 计数必须 ≥1（否则 BOOT-1 是恒真的哑巴判据）",
    ).toBeGreaterThanOrEqual(1);
  });

  it("BOOT-2: 预热之后写入必须真的生效（不许把缺陷修成「永远不写」）", async () => {
    const port = unwarmedPort();
    setStoragePort(port);
    const ctx = await applyAll(WRITING_PROVIDERS, port);
    await port.config.warmup();

    // shell-ops：第一次判定时才落默认值（真机取证的那条路径）
    const svc = (ctx as any).get("shellOps", false);
    expect(svc, "前置条件：服务必须在").toBeTruthy();
    svc.plan("git status");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(getSetting(SHELL_OPS_ENABLED_KEY), "预热后第一次判定必须把默认设置真的落库").not.toBeNull();
    expect(port.config.stats().writes, "必须真的写进去过").toBeGreaterThan(0);
    expect(port.config.stats().blockedWrites, "预热后不该再有被拒的写").toBe(0);
  });

  it("BOOT-3: 静态全量 —— 会写设置的 provider/插件模块必须逐条分类（含时机）", () => {
    /**
     * 分类表：`模块 → 时机`。
     * - `调用期`：写入发生在方法/闭包里（用户动作或首次使用时才跑）—— 安全；
     * - `启动期`：写入可能在 apply/构造期执行 —— 必须走"预热后 + 确认式"的路径，否则 BOOT-1 会红。
     *
     * 表与代码必须**双向相等**：新出现一个会写设置的 provider，就必须在这里被分类
     * （这正是"同类问题系统性排查"要的棘轮 —— 不分类就红）。
     */
    const CLASSIFIED: Record<string, "调用期"> = {
      "src/core/provider/credentials-provider.ts": "调用期",
      "src/core/provider/plans-provider.ts": "调用期",
      "src/core/provider/preset-provider.ts": "调用期",
      "src/plugins/shell-ops/policy.ts": "调用期",
    };

    const WRITE_CALL = /(?:^|[^.\w])(?:setSetting|setSettingJSON|setSettingConfirmed|removeSetting)\s*\(/;
    const roots = [path.join(ROOT, "src/core/provider"), path.join(ROOT, "src/plugins")];
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
          const text = fs.readFileSync(p, "utf8");
          // 只看生产代码（剥掉注释，避免注释里提到函数名被误判）
          const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
          if (WRITE_CALL.test(code)) found.add(path.relative(ROOT, p).replace(/\\/g, "/"));
        }
      }
    };
    for (const r of roots) walk(r);

    expect(found.size, "必须真的扫到东西（否则这条判据没有对象）").toBeGreaterThan(0);
    expect(
      [...found].sort(),
      "这些模块会写设置，但没在 BOOT-3 的分类表里 —— 请判断它的写入时机：\n" +
        "  调用期（方法/闭包里，安全）⇒ 加进 CLASSIFIED 并在 BOOT-1 里装配它；\n" +
        "  启动期（apply/构造期可能跑）⇒ 挪到预热后 + 确认式写入，再用 BOOT-1 钉住。",
    ).toEqual(Object.keys(CLASSIFIED).sort());
  });
});
