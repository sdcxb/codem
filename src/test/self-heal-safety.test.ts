/**
 * 自检（self-heal）的**安全判据**契约（第 11 轮）。
 *
 * ## 这一组用例守的是一条真机上发生过的数据事故
 *
 * `verifyUserContentOrRestore` 在判定"用户内容无故消失"之后会执行 `migration.auto` ——
 * 而那条命令会**重写整库**。所以这个判据一旦误报，代价是"对一份完好的数据库做破坏性恢复"。
 *
 * 真机证据（`storage_audit` 触发器，见 `docs/L3-DELETION-PLAN.md` 第五节）：
 * - 2026-09-17T01:13:34Z 一次性删掉 sessions 3 行 + **messages 821 条（全部）**
 *   + tool_calls 883 + session_events 2131，与 `migration.auto` 的"整表清空再重灌"
 *   完全吻合，并且与"旧库被打开"（`codem-db.bin-shm` mtime）**同秒**；
 * - 而同一次启动里控制台还有一处可观测的空读（`loadFromDB: found 0 projects`）。
 *
 * 因此判据必须满足三条（每条一个用例）：
 * 1. **读不到 ≠ 是 0** —— 计数读取失败时绝不恢复、绝不改水位；
 * 2. **0 必须复核** —— 首次 0、复核非 0（读抖动）时不恢复；
 * 3. 真丢时才恢复 —— 连续两次 0 + 高水位 + 旧库确有内容，才允许跑 `migration.auto`。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const WATERMARK_KEY = "codem-storage-content-watermark";

/** 预置一个"上次有 821 条消息"的水位（异常判据的输入） */
const watermarkRow = (messages: number, sessions = 3) => ({
  key: WATERMARK_KEY,
  value: JSON.stringify({ at: 1, messages, sessions }),
});

/**
 * **真正的恢复调用**（排除 `dry_run` 探测）。
 *
 * `legacyHasMessages` 也会用 `migration.auto` 去**只读探测**旧库（`dry_run: true`），
 * 所以"有没有调用过 migration.auto"这种断言会把探测也算进去 —— 必须区分开，
 * 否则用例会在"只探测、没恢复"时误报为"恢复了"。
 */
const restoreCalls = (port: { __writes(): Array<{ command: string; params?: Record<string, unknown> }> }) =>
  port.__writes().filter((w) => w.command === "migration.auto" && w.params?.dry_run !== true);

const messageRow = (id: string, timestamp: number) => ({
  id,
  session_id: "s1",
  role: "user",
  content: `内容-${id}`,
  timestamp,
  hidden: 0,
});

afterEach(() => {
  setStoragePort(null);
  failures.length = 0;
  vi.restoreAllMocks();
  /*
   * ⚠️ 这里**不能** `vi.resetModules()`：本文件用静态 import 拿 `setStoragePort`，
   * 而 `self-heal` 是动态 import 的。一旦重置模块表，两者会拿到**不同的 port 模块实例** ——
   * 测试设的端口对被测代码不可见，于是每个用例都得到 `unavailable（端口未注册）`：
   * 看起来"通过"，实际什么都没验证（实测踩到：SH-2/3/4/5 全红，原因就是这个）。
   */
});

describe("自检判据的安全性", () => {
  it("SH-1: 计数读不到时**绝不恢复**（读不到 ≠ 是 0）", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [watermarkRow(821)], messages: [] },
      legacyMessageRows: 821,
    });
    // 让 `crud.count` 失败：这就是真机上"端口还没就绪 / 命令出错"的形态
    const original = port.data.command!;
    (port.data as { command: unknown }).command = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "crud.count") throw new Error("模拟：crud.count 暂时不可用");
      return original.call(port.data, cmd, params);
    };
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind, "读不到就不能判定为异常").toBe("unavailable");
    expect(
      restoreCalls(port).length,
      "读不到时**绝不能**跑重写整库的恢复命令（这正是 821 条被清空的形态）",
    ).toBe(0);
  });

  it("SH-2: 首次读到 0、复核不为 0 → 判定为读抖动，不恢复", async () => {
    const port = createFakeStoragePort({
      // 表里**确实有** 3 条消息：只有首次 crud.count 会谎报 0（模拟一次读抖动）
      seed: { settings: [watermarkRow(821)], messages: [messageRow("m1", 1), messageRow("m2", 2), messageRow("m3", 3)] },
      legacyMessageRows: 821,
    });
    let calls = 0;
    const original = port.data.command!;
    (port.data as { command: unknown }).command = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "crud.count" && params?.table === "messages") {
        calls += 1;
        if (calls === 1) return { count: 0, table: "messages" } as never;
      }
      return original.call(port.data, cmd, params);
    };
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind).toBe("ok");
    expect(res.current?.messages, "复核读到的才是真相").toBe(3);
    expect(restoreCalls(port).length, "一次读抖动不该触发重写整库").toBe(0);
  });

  it("SH-3: 连续两次 0 + 高水位 + 旧库有内容 → 才允许恢复", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [watermarkRow(821)], messages: [] },
      legacyMessageRows: 5,
    });
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind, "真丢时自愈必须生效（这是它的本职）").toBe("restored");
    expect(restoreCalls(port).length, "真丢时必须真的恢复").toBe(1);
    expect(res.current?.messages, "恢复前后都要如实报数").toBe(0);
  });

  it("SH-4: 水位不高（用户本来就只有几条）→ 不判定为异常", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [watermarkRow(3)] },
      legacyMessageRows: 3,
    });
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind).toBe("ok");
    expect(restoreCalls(port).length).toBe(0);
  });

  it("SH-5: 旧库没有可恢复内容时只上报、不恢复（避免用空数据覆盖）", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [watermarkRow(821)], messages: [] },
      legacyMessageRows: 0,
    });
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind).toBe("suspicious");
    expect(restoreCalls(port).length).toBe(0);
    expect(failures.some((f) => f.includes("旧库也没有内容")), "要留下可诊断的痕迹").toBe(true);
  });

  /**
   * ## B-9：水位"读不到"与"真是 0"必须分开
   *
   * 原实现是 `readWatermark(...) → Watermark | null`，调用方写
   * `(previous?.messages ?? 0) >= SUSPICIOUS_MIN_MESSAGES` —— `?? 0` 把
   * "这一行没读到"（settings 项坏了 / JSON 解析失败）当成"上次水位是 0"，
   * 于是 `suspicious` 恒为 false：**自愈被静默解除武装**，而且没有任何痕迹。
   */
  it("SH-6: 水位读不到时**不判定、也不覆盖水位**（读不到 ≠ 上次是 0）", async () => {
    const port = createFakeStoragePort({
      // 水位行存在但内容坏了（JSON 解析失败）—— 真机上对应"settings 面写入被打断"
      seed: { settings: [{ key: WATERMARK_KEY, value: "{坏掉的 json" }], messages: [] },
      legacyMessageRows: 821,
    });
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind, "水位读不到 → 本次不判定（既不当成健康、也不当成丢失）").toBe("unavailable");
    expect(restoreCalls(port).length, "水位读不到时绝不能恢复").toBe(0);
    expect(
      port.__writes().filter((w) => w.command === "settings.set").length,
      "**绝不能**把水位覆盖成「现在的 0」—— 那才是真正的永久解除武装",
    ).toBe(0);
    expect(
      failures.some((f) => f.includes("本次自检不判定")),
      "要留下可诊断的痕迹（否则「自愈为什么没生效」永远查不出来）",
    ).toBe(true);
  });

  /**
   * ## B-9：恢复之后必须**复核**，成功了才清标记（写水位）
   *
   * 原实现是"跑完 `migration.auto` → 无条件 `writeWatermark({ messages: after ?? 0 })`
   * → 返回 `kind: "restored"`"。三种坏形态（见报告）：
   * 命令报错、恢复后仍是 0、复核读不到 —— 三者都会把水位写成 0，
   * 从此"上次水位很低" → 下次启动不再判定异常 → **自愈被永久解除武装**。
   */
  it("SH-7: 恢复后复核不通过 → 保持原水位、不谎报 restored、如实上报", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [watermarkRow(821)], messages: [] },
      // 旧库**有**内容（否则会在更早一步被挡掉）
      legacyMessageRows: 5,
    });
    /**
     * 把"真正的恢复"替换成"命令成功返回、但**一行都没搬**"——
     * 真机上对应的形态是 `migration.auto` 报成功而库内容没变（旧库路径过期、
     * 部分表被跳过，或源库那几张表本来就是空的）。
     *
     * ⚠️ 观测点必须自己记（`restoreCalls()` 依赖假端口的 `__writes()`，而**自己实现的
     * 桩不会写进那份日志** —— 实测踩到：断言"恢复跑过一次"收到 0）。
     * 所以这里单独记一份调用，再转发 `dry_run` 探测给原始实现。
     */
    const realRestores: Array<Record<string, unknown> | undefined> = [];
    const original = port.data.command!;
    (port.data as { command: unknown }).command = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "migration.auto" && params?.dry_run !== true) {
        realRestores.push(params); // 记下来：恢复确实被调用过
        return { migrated: true, tables: 1, rows: 5, total_rows: 5 } as never; // 一行没写
      }
      return original.call(port.data, cmd, params);
    };
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind, "复核仍是 0 → 不允许报「已恢复」").toBe("suspicious");
    expect(realRestores.length, "恢复命令确实跑过一次（这是事实，要如实）").toBe(1);
    const watermarkWrites = port
      .__writes()
      .filter((w) => w.command === "settings.set" && (w.params as Record<string, unknown>)?.key === WATERMARK_KEY);
    expect(
      watermarkWrites.length,
      "**水位必须保持原样**（写入 0 等于让下一次自检失去判据 = 永久解除武装）",
    ).toBe(0);
    expect(
      failures.some((f) => f.includes("复核")),
      "复核不通过必须留下可诊断的原因",
    ).toBe(true);
  });

  it("SH-8: 恢复成功且复核通过 → 才写水位、才报 restored", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [watermarkRow(821)], messages: [] },
      legacyMessageRows: 5,
    });
    setStoragePort(port);

    const { verifyUserContentOrRestore } = await import("../core/storage/self-heal");
    const res = await verifyUserContentOrRestore("C:/legacy.bin");

    expect(res.kind).toBe("restored");
    expect(res.current?.messages, "恢复前如实报 0 条").toBe(0);
    const watermarkWrites = port
      .__writes()
      .filter((w) => w.command === "settings.set" && (w.params as Record<string, unknown>)?.key === WATERMARK_KEY);
    expect(watermarkWrites.length, "复核通过才允许更新水位").toBe(1);
    const saved = JSON.parse(String((watermarkWrites[0].params as Record<string, unknown>).value)) as {
      messages: number;
    };
    expect(saved.messages, "水位必须是**复核读到的真实行数**").toBe(5);
  });
});
