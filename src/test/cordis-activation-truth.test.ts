/**
 * Cordis 装配的**真实激活口径**（第 184 波 F6）。
 *
 * ## 缺陷形态
 *
 * `loadFromEntries` 在 `ctx.plugin(plugin)` 返回后立刻 `result.loaded.push(entry.id)`，
 * 而激活是**异步**的（`cordis/src/fiber.ts:647-665`：先 `await Promise.resolve()` 再 `_execute`，
 * 失败写 `_error`）⇒ 「Loaded 60, failed 0」只是**愿望清单**：
 * 装配了多少与真的在跑多少是两个口径。
 * 唯一权威校验 `assertActivated` 的失败在 `App.tsx` 的唯一调用点被降级成一行
 * `console.error`（"不终止启动"），随后同一函数仍打印 `completed successfully`。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | CORDIS-F6-1 | `loadFromEntries` 的 `loaded` = **已装配**（异步失败的插件也在里面，且此时 `activated` 未结算） |
 * | CORDIS-F6-2 | `settleActivation` 后：真的 ACTIVE 才算 `activated`，抛错/挂住的进 `notActivated` + `failed` |
 * | CORDIS-F6-3 | 启动汇总（纯函数）：有未激活条目时**不许**出现 `completed successfully` |
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "../core/cordis/src/index.ts";
import { builtinPlugins } from "../core/plugin-loader/index";
import { loadFromEntries, settleActivation, formatBootCompletion } from "../core/plugin-loader/yaml-loader";

const OK = "@codem/f6-ok";
const BOOM = "@codem/f6-boom";

function registerSynthetic(name: string, apply: () => any) {
  builtinPlugins.set(name, {
    meta: { name, provides: [], inject: [], core: false } as never,
    apply,
  });
}

afterEach(() => {
  builtinPlugins.delete(OK);
  builtinPlugins.delete(BOOM);
  vi.restoreAllMocks();
});

describe("Cordis 装配的激活口径（第 184 波 F6）", () => {
  it("CORDIS-F6-1/F6-2: loaded 说的是「已装配」；settleActivation 才给出「真的激活」", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerSynthetic(OK, () => () => {});
    // 激活阶段抛错（**不是**装配阶段抛错）：`ctx.plugin` 不会抛，错误进 fiber._error
    registerSynthetic(BOOM, () => () => {
      throw new Error("激活失败（异步）");
    });

    const ctx = new Context();
    const res = loadFromEntries(ctx as any, [
      { id: "f6-ok", name: OK },
      { id: "f6-boom", name: BOOM },
    ]);

    expect(res.loaded.slice().sort(), "装配阶段两条都没抛").toEqual(["f6-boom", "f6-ok"]);
    expect(res.failed, "装配阶段的 failed 是空的 —— 这正是「愿望清单」的成因").toEqual([]);
    expect(res.activated, "还没结算：装配 ≠ 激活，这个区分必须是显式的").toBeUndefined();
    expect(res.handles?.map((h) => h.id).sort(), "留下句柄供结算").toEqual([
      "f6-boom",
      "f6-ok",
    ]);

    const settled = await settleActivation(res, 3000);

    expect(settled.activated, "只有真的进了 ACTIVE 才算激活").toEqual(["f6-ok"]);
    expect(settled.notActivated?.map((n) => n.id), "异步失败的必须如实落在这里").toEqual([
      "f6-boom",
    ]);
    expect(settled.notActivated?.[0]?.reason).toContain("激活失败");
    expect(
      settled.failed.map((f) => f.name),
      "未激活的还要进 failed，让既有的 fail-loud 分支与启动汇总照实报出来",
    ).toEqual(["f6-boom"]);
    expect(ctx.get("f6-ok", false) ?? true, "对照：另一个插件确实装配进 ctx 了").toBeTruthy();
  });

  it("CORDIS-F6-2b: 一直等不到依赖（PENDING）⇒ 不许算作已激活", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = new Context();
    const fiber = ctx.plugin({
      name: BOOM,
      inject: ["never-provided-service"],
      apply() {},
    } as never);

    const settled = await settleActivation(
      { loaded: ["f6-boom"], skipped: [], failed: [], handles: [{ id: "f6-boom", name: BOOM, fiber }] },
      300,
    );

    expect(settled.activated).toEqual([]);
    expect(settled.notActivated?.length).toBe(1);
    expect(settled.notActivated?.[0]?.reason).toMatch(/未完成|超过|state/);
  });

  it("CORDIS-F6-3: 启动汇总不许在插件未激活时谎称成功", () => {
    const ok = formatBootCompletion([]);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("completed successfully");

    const bad = formatBootCompletion([
      "llm: FAILED — 服务缺失",
      "session: PENDING (waiting for service: store)",
    ]);
    expect(bad.ok, "有未激活条目就不是成功启动").toBe(false);
    expect(
      bad.message,
      "改前这条汇总无条件打印 completed successfully —— 排障时被这句成功日志误导",
    ).not.toContain("completed successfully");
    expect(bad.message).toContain("llm: FAILED");
    expect(bad.message).toContain("WITH FAILURES");
  });

  it("CORDIS-F6-4 接线护栏：启动链必须真的走这两条口径（别让汇总函数变成摆设）", () => {
    const src = readFileSync(join(__dirname, "../App.tsx"), "utf8");
    expect(src, "必须结算真实激活口径").toContain("settleActivation(yamlResult)");
    expect(src, "必须把未激活条目汇总进启动结论").toContain("formatBootCompletion(activationErrors)");
    expect(src, "未激活条目必须被收集").toContain("activationErrors.push");
    expect(
      /console\.log\(\s*['"`]\[Cordis\]\s*getCordisContext completed successfully/.test(src),
      "改前是无条件打印「completed successfully」—— 必须由汇总决定（失败时打 error）",
    ).toBe(false);
  });
});
