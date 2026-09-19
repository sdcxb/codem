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
});
