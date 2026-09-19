/**
 * 凭据普查契约（第 62 轮；`docs/CREDENTIALS-PLAN.md` 阶段 0-c）
 *
 * 判据三条，缺一条这条能力就是假的：
 * 1. **命中要报**（键名 + 数量）；
 * 2. **值绝不外泄** —— 返回的对象里不许出现密钥文本（这条最重要：一个"把密钥打印出来"的
 *    安全特性本身就是新的泄露面）；
 * 3. **不许误报普通设置**（模型名、主题、温度、纯计数键），否则用户会习惯性忽略这条提示。
 */

import { describe, expect, it } from "vitest";

import { censusCredentialSettings } from "../core/storage/credential-census";

const SK = "sk-abcdefghijklmnopqrstuvwx";
const GHO = "gho_ABCDEFGHIJKLMNOPQRSTUV";

describe("CENSUS：设置里的凭据普查", () => {
  it("CENSUS-1: 命中要报（键名 + 数量），且**值绝不外泄**", () => {
    const rows = [
      { key: "codem-settings", value: JSON.stringify({ providers: [{ id: "deepseek", apiKey: SK }] }) },
      { key: "note", value: `排查记录：当时用的是 ${GHO} 这个 token` },
      { key: "theme", value: "dark" },
    ];
    const out = censusCredentialSettings(rows);

    expect(out.scanned).toBe(3);
    expect(out.total).toBeGreaterThanOrEqual(2);
    const keys = out.hits.map((h) => h.key);
    expect(keys).toContain("codem-settings");
    expect(keys).toContain("note");

    // ② 值绝不外泄：整个返回结构序列化后不许出现密钥文本
    const serialized = JSON.stringify(out);
    expect(serialized, "普查结果里出现了密钥 = 这个'安全特性'自己成了泄露面").not.toContain(SK);
    expect(serialized).not.toContain(GHO);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("CENSUS-2: 普通设置不许误报（模型名/主题/温度/纯计数键）", () => {
    const rows = [
      { key: "codem-settings", value: JSON.stringify({ model: "deepseek-v4-flash", temperature: 0.7 }) },
      { key: "codem-theme", value: "dark" },
      { key: "codem-token-count", value: "123456" },
      { key: "codem-secret-santa-list", value: "alice,bob" },
      { key: "codem-api-key-hint", value: "请在设置里填写" },
    ];
    const out = censusCredentialSettings(rows);
    expect(out.total, "误报会让真提示贬值（本仓库反复吃过这个亏）").toBe(0);
    expect(out.hits).toEqual([]);
  });

  it("CENSUS-3: 空值/空键名不许被当成凭据，也不许把扫描数算错", () => {
    const rows = [
      { key: "", value: SK },
      { key: "empty", value: "" },
      { key: "nullish", value: null },
      { key: "blank", value: "   " },
    ];
    const out = censusCredentialSettings(rows);
    expect(out.scanned, "空键名不计入扫描数").toBe(3);
    expect(out.total, "空值不构成凭据").toBe(0);
  });

  it("CENSUS-4: 带 `g` 的正则逐行复用不许漏命中（经典陷阱：lastIndex 不重置）", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, value: `token sk-abcdefghijklmnopqrstuvwx` }));
    const out = censusCredentialSettings(rows);
    expect(out.total, "5 行都该命中；只命中第一行说明 lastIndex 没重置").toBe(5);
  });

  it("CENSUS-5: **已加密**的字段不许被报成明文凭据（真机复量抓到的假话）", () => {
    /**
     * 真机现象（1.16.104，封存已生效）：维护日志打出
     * 「设置里存在**明文存放的**密钥 1 处：codem-settings(field×1)」，
     * 而那一刻磁盘上是 `"apiKeySealed": "dsh1:…"` —— 键名判据把 `apiKeySealed`
     * 当成 `apiKey` 命中了（子串），于是"明文"这两个字是假的。
     */
    const sealed = JSON.stringify({
      providers: [{ id: "deepseek", apiKeySealed: "dsh1:" + "ab".repeat(60) }],
    });
    const out = censusCredentialSettings([{ key: "codem-settings", value: sealed }]);
    expect(out.total, "密文不是明文凭据 ⇒ 不许进明文告警").toBe(0);
    expect(out.hits).toEqual([]);
    expect(out.sealedTotal, "但必须**如实说清**有几处已加密").toBe(1);
    expect(out.sealedKeys).toEqual(["codem-settings"]);

    // 对照组：同一形状但值是明文 ⇒ 必须命中（别把这条修成"永远不报"）
    const plain = JSON.stringify({ providers: [{ id: "deepseek", apiKey: "sk-abcdefghijklmnopqrstuvwx" }] });
    const out2 = censusCredentialSettings([{ key: "codem-settings", value: plain }]);
    expect(out2.total).toBeGreaterThan(0);
    expect(out2.sealedTotal).toBe(0);

    // 两者并存（真机上真实出现过）：明文那处要报，已加密那处只计数不告警
    const both = JSON.stringify({
      providers: [
        { id: "deepseek", apiKey: "sk-abcdefghijklmnopqrstuvwx", apiKeySealed: "dsh1:" + "cd".repeat(60) },
      ],
    });
    const out3 = censusCredentialSettings([{ key: "codem-settings", value: both }]);
    expect(out3.total, "明文那一处必须仍然报出来").toBeGreaterThan(0);
    expect(out3.sealedTotal).toBe(1);
    // 序列化后不许出现任何值
    expect(JSON.stringify(out3)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(JSON.stringify(out3)).not.toContain("cdcdcd");
  });
});
