/**
 * 导出设置的**凭据脱敏**契约（第 62 轮；见 `docs/CREDENTIALS-PLAN.md` 阶段 0）
 *
 * ## 为什么这条要单独钉
 *
 * `exportSettings()` 把各来源的设置原样返回，而界面上有"导出"按钮 ——
 * 导出文件是**用户会随手分享/上传**的东西，原样导出等于把 API key 交出去。
 * 本会话已经有过一次近事故（库文件被 `git add -A` 带进提交、被 GitHub push protection 拦下），
 * 说明"明文落盘 + 可被带走"是真风险，不是理论风险。
 *
 * ## 判据（两条，且都只替换 + 计数，从不打印值）
 *
 * 1. **键名**像凭据 → 值换占位符（哪怕值形状不像，比如自建网关的短 token）；
 * 2. **值形状**像凭据 → 换占位符（哪怕键名不像 —— 本仓库真发生过：一个
 *    GitHub token 形状的值出现在 reasoning / 工具结果 / 事件载荷里）。
 *
 * 只测一条会漏另一条，所以这里两条都要有用例，并且带**对照组**：
 * 普通设置（模型名、主题、温度）**不许**被改掉，否则"脱敏"会变成"把配置改坏"。
 */

import { describe, expect, it } from "vitest";

import { redactCredentialShapes } from "../core/settings/settings";

describe("CRED：导出设置的凭据脱敏", () => {
  it("CRED-1: 键名像凭据 → 值变占位符（形状不像也要拦）", () => {
    const input = {
      providers: [
        { id: "deepseek", apiKey: "short-gateway-token", baseUrl: "https://api.example.com" },
        { id: "openai", api_key: "another-short-one" },
        { id: "custom", authToken: "abc123" },
      ],
    };
    const { value, redacted } = redactCredentialShapes(input);
    const text = JSON.stringify(value);

    expect(text).not.toContain("short-gateway-token");
    expect(text).not.toContain("another-short-one");
    expect(text).not.toContain("abc123");
    expect(text).toContain("<redacted:credential-field>");
    expect(redacted, "三处凭据字段都要计数").toBe(3);
    // 对照组：非凭据字段不许被动
    expect(text).toContain("https://api.example.com");
    expect(text).toContain("deepseek");
  });

  it("CRED-2: 值形状像凭据 → 拦（哪怕键名完全不像）", () => {
    const input = {
      note: "排查记录：当时用的是 sk-abcdefghijklmnopqrstuvwx 这个 key",
      nested: { zh: "token gho_ABCDEFGHIJKLMNOPQRSTUV" },
      arr: ["AKIAIOSFODNN7EXAMPLE"],
    };
    const { value, redacted } = redactCredentialShapes(input);
    const text = JSON.stringify(value);

    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(text).not.toContain("gho_ABCDEFGHIJKLMNOPQRSTUV");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).toBeGreaterThanOrEqual(3);
  });

  it("CRED-3: 普通设置一个字都不许改（脱敏 ≠ 改坏配置）", () => {
    const input = {
      model: "deepseek-v4-flash",
      theme: "dark",
      temperature: 0.7,
      providers: [{ id: "deepseek", baseUrl: "https://api.deepseek.com", models: ["a", "b"] }],
      nested: { list: [1, 2, 3], flag: true, nothing: null },
    };
    const { value, redacted } = redactCredentialShapes(input);
    expect(redacted).toBe(0);
    expect(value).toEqual(input);
  });

  it("CRED-4: 空值与 undefined 不许被当成凭据（避免把'没填'写成'已脱敏'）", () => {
    const input = { apiKey: "", api_key: "   ", other: undefined };
    const { value, redacted } = redactCredentialShapes(input);
    expect(redacted).toBe(0);
    expect(JSON.stringify(value)).toContain('"apiKey":""');
  });
});
