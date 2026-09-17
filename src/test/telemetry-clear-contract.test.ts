/**
 * `telemetry.clearAll()` 的**返回契约**（第 44 轮补 4）。
 *
 * ## 守的是什么
 *
 * `domainDeleteWhere` 的返回值有两个不能互相冒充的含义（`domain-mirror-window.test.ts`
 * 的 WIN-6 钉着这条）：
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `null` | **没接手**（端口没注册 / 镜像未就绪 / 已排队待重放）—— 本次同步调用什么也没做 |
 * | `0` | **接手了**，确实没有可删的行 |
 * | `N` | 接手了，删了 N 行 |
 *
 * `clearAll()` 原来是 `return removed ?? 0` —— 把"没接手"压成了"没有可清空的"。
 * 更糟的是它上方那段注释**明确承诺**了"没删成一定伴随上报，不会静默"：
 * 注释与实现相反，正是这个仓库查出缺陷最多的形态（第 44 轮 `trimmed` 那次就是）。
 *
 * 所以这里要证明的是两件事：
 * 1. 走到那个分支时**必须**上报（`getPersistFailures()` 里能看到 `telemetry.clearAll`）；
 * 2. 上报之后仍然返回 `0`（**UI 契约不变**：`PerformanceDashboard` 拿 number 渲染
 *    "已清空 N 条 / 没有可清空的遥测事件"，而它的文案已经写着"若刚写过，见失败提示"）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";

/**
 * 造一个"读的时候还就绪、删的时候已经不就绪"的端口 —— 也就是那个窗口。
 *
 * 为什么用 `ensureLoaded` 当开关：`domainMirror()` 的顺序是
 * **先 `ensureLoaded(...)`、再 `isReady(...)`**（见 `domain-store.ts:97-100`）。
 * 所以"第 N 次 ensureLoaded 起把 ready 置假"能在**两次同步调用之间**精确地制造状态翻转，
 * 又不必去数 `isReady` 到底被调用了几次（数调用次数的测试会在实现微调时碎掉）。
 */
function vanishingPort(): StoragePort {
  let loadedCalls = 0;
  let ready = true;
  const executed: Array<{ command: string; params?: Record<string, unknown> }> = [];
  const stub = {
    kind: "rust",
    domains: {
      ensureLoaded: (_table: string) => {
        loadedCalls += 1;
        // 第 2 次起：镜像"就在这一次操作的中途"失去就绪（被逐出 / 被撤销）
        if (loadedCalls >= 2) ready = false;
      },
      isReady: () => ready,
      isLoading: () => false,
      all: () => [
        { id: "t1", session_id: "s1", name: "llm_call", timestamp: 1, data: "{}" },
      ],
      applyDeleteWhere: () => 1,
    },
    data: {
      execute: async (command: string, params?: Record<string, unknown>) => {
        executed.push({ command, params });
        return { written: 1 };
      },
    },
    __loadedCalls: () => loadedCalls,
    __executed: () => executed,
  };
  return stub as unknown as StoragePort;
}

beforeEach(() => {
  resetPersistFailures();
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
});

describe("telemetry.clearAll —— 未接手必须如实上报（不许说成'没有可清空的'）", () => {
  it("CLEAR-1: 删除时端口未接手 → 上报 `telemetry.clearAll` 并返回 0（UI 契约不变）", async () => {
    const port = vanishingPort();
    setStoragePort(port);

    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel = getTelemetry();
    const removed = tel.clearAll();

    const failures = getPersistFailures();
    expect(
      failures.map((f) => f.area),
      "没删成却没上报 = 把'什么都没做'说成'没有可清空的'（正是本次要堵的静默失败）",
    ).toContain("telemetry.clearAll");
    expect(failures.find((f) => f.area === "telemetry.clearAll")?.lastMessage).toContain("未接手");
    expect(removed, "返回值仍是 number：UI 契约（PerformanceDashboard）不许被改坏").toBe(0);
    expect(
      (port as unknown as { __executed(): unknown[] }).__executed(),
      "未接手时一条删除命令都不该发出去",
    ).toEqual([]);
  });

  it("CLEAR-2: 镜像正常就绪时照常删除，且**没有**任何失败上报（别把正常路径也报成失败）", async () => {
    const port = vanishingPort();
    // 只让第 1 次 ensureLoaded 发生（读与删都就绪）：把开关推迟到第 99 次
    (port as unknown as { domains: { ensureLoaded: () => void } }).domains.ensureLoaded = () => {};
    setStoragePort(port);

    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel = getTelemetry();
    const removed = tel.clearAll();

    expect(removed, "就绪时按真实删除行数返回").toBe(1);
    expect(
      getPersistFailures().map((f) => f.area),
      "正常路径不许上报失败（假失败与假成功一样是噪音）",
    ).not.toContain("telemetry.clearAll");
  });
});
