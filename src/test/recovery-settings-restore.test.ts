/**
 * 损坏恢复：**抢救出来的设置**该不该写回（第 57 轮）
 *
 * ## 为什么这组用例比"能恢复"更重要
 *
 * 引擎会把坏文件里能读出来的 `settings` 抄进旁路文件（那是审计里「损坏库备份**无等价物**」
 * 的闭合动作：消息有权威日志、归属有抢救，**只有设置什么都没有**）。
 * 但"读出来"与"写回去"是两件事：有几个键描述的是**那份旧索引的派生状态**，
 * 把它们带到一份**全新的空库**上，会让新库的自我修复机制做出错误判断 ——
 * 最狠的一条是自愈水位（详见 `BLOCKED_RESTORE_KEYS` 里逐条写的理由）。
 *
 * 所以这里的判据是三条**独立的**性质，每条都对应一种真实的错误做法：
 *
 * | 用例 | 挡住的错误做法 |
 * | --- | --- |
 * | SET-RESTORE-1 | 什么都不做（"设置丢了就丢了吧"）—— 用户偏好永久丢失 |
 * | SET-RESTORE-2 | 无条件覆盖（把启动早期刚写的当前状态盖回旧快照） |
 * | SET-RESTORE-3 | 连"派生状态标记"一起继承（武装自愈的破坏性路径 / 让新库跳过 FTS 重建 / 推迟自检） |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPersistFailures } from "../core/storage/persist-failure";

let port: import("./fake-storage-port").FakeStoragePort;

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  port = createFakeStoragePort({ seed: {} });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  await new Promise((r) => setTimeout(r, 20));
});

afterEach(async () => {
  const { setStoragePort } = await import("../core/storage/port");
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("SET-RESTORE：损坏恢复后的设置写回策略", () => {
  it("SET-RESTORE-1: 新库缺的键**要补上**（否则用户偏好永久丢失）", async () => {
    const { restoreRecoveredSettings } = await import("../core/storage/recovery-restore");
    const { getSetting } = await import("../core/storage/settings");

    const out = restoreRecoveredSettings({
      settings: [
        { key: "codem-language", value: "zh" },
        { key: "codem-theme", value: "dark" },
        { key: "skin-id", value: "pet" },
      ],
    });

    expect(out.restored, "三条都该写回").toBe(3);
    expect(getSetting("codem-language")).toBe("zh");
    expect(getSetting("codem-theme")).toBe("dark");
    expect(getSetting("skin-id")).toBe("pet");
  });

  it("SET-RESTORE-2: 新库里**已经有**的键不许覆盖（旧快照不能盖掉当前状态）", async () => {
    const { restoreRecoveredSettings } = await import("../core/storage/recovery-restore");
    const { setSetting, getSetting } = await import("../core/storage/settings");

    // 启动早期渲染侧主动写下的"当前状态"（例如 provider/模型同步的结果）
    setSetting("codem-theme", "light");

    const out = restoreRecoveredSettings({
      settings: [
        { key: "codem-theme", value: "dark" }, // 旧库那一份
        { key: "codem-language", value: "zh" }, // 新库没有 → 可以补
      ],
    });

    expect(out.keptExisting, "已存在的要计入 keptExisting").toBe(1);
    expect(out.restored).toBe(1);
    expect(
      getSetting("codem-theme"),
      "旧快照绝不能盖掉这一版真正想要的当前状态（否则用户看到设置自己跳回去）",
    ).toBe("light");
    expect(getSetting("codem-language"), "缺的那条要补上").toBe("zh");
  });

  it("SET-RESTORE-3: 派生状态标记**按策略拒绝继承**（自愈水位 / FTS 标记 / 检查时间戳）", async () => {
    const { restoreRecoveredSettings, BLOCKED_RESTORE_KEYS } = await import(
      "../core/storage/recovery-restore"
    );
    const { getSetting } = await import("../core/storage/settings");

    const blocked = BLOCKED_RESTORE_KEYS.map((b) => b.key);
    const out = restoreRecoveredSettings({
      settings: [
        // 三个必须拒绝的
        { key: "codem-storage-content-watermark", value: '{"at":1,"messages":821,"sessions":3}' },
        { key: "codem-fts-bigram-rebuilt", value: "true" },
        { key: "codem-storage-integrity-checked-at", value: "1789000000000" },
        // 一个正常的（对照组：证明拒绝是**按名单**的，不是"全都拒绝"）
        { key: "codem-language", value: "zh" },
      ],
    });

    expect(out.blocked, "三条都要被拒绝").toBe(3);
    expect(out.blockedKeys.sort()).toEqual([...blocked].sort());
    expect(out.restored, "对照组要被写回").toBe(1);

    for (const key of blocked) {
      expect(getSetting(key), `${key} 绝对不该被继承回来`).toBeNull();
    }
    /**
     * 单独把**最危险**的那条说清楚：自愈水位一旦落库，下一次自检就是
     * "上次 821 条、现在 0 条 ⇒ 疑似丢失 ⇒ migration.auto（整库 replace）"。
     * 这条断言是这组用例存在的根本理由。
     */
    expect(
      getSetting("codem-storage-content-watermark"),
      "水位必须为空：没有基线 ⇒ 自愈只记录新水位，不会去跑破坏性的 migration.auto",
    ).toBeNull();
  });

  it("SET-RESTORE-4: 形状不对 / 没有这一节 → 安静地什么都不做（不是错误）", async () => {
    const { restoreRecoveredSettings } = await import("../core/storage/recovery-restore");
    for (const payload of [undefined, null, {}, { settings: "oops" }, { settings: [] }, []]) {
      const out = restoreRecoveredSettings(payload);
      expect(out, `payload=${JSON.stringify(payload)} 必须安静返回 0`).toEqual({
        restored: 0,
        keptExisting: 0,
        blocked: 0,
        failed: 0,
        blockedKeys: [],
      });
    }
  });
});
