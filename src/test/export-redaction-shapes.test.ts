/**
 * 导出脱敏：**上下文形状**与**复数/cookie 键名**都要盖住（第 233 轮审计 · P2 泄漏）。
 *
 * ## 缺陷形态
 *
 * `redactCredentialShapes`（导出用）只取 `CREDENTIAL_VALUE_RES`（`scope === "value"`），
 * 而 `redact.ts` 的日志脱敏用的是**全表**（含 `scope === "context"`：私钥块、
 * `Bearer …`、`password=…`、`secret=`、`token=`）。于是：
 *
 * - `.codem/settings.json` 里某个**非凭据键名**下放着
 *   `-----BEGIN RSA PRIVATE KEY-----…`、或一条带 `password=s3cret` 的连接串 ⇒
 *   导出文件里**原样带出去**（导出是给用户分享/排障用的）；
 * - 键名判据也只认单数（`apiKey`），`apiKeys` / `cookies` 这类常见的复数键名不命中。
 *
 * 修法与仓库既有纪律一致：**形状只有一份**（`credential-shapes.ts`），导出与日志脱敏
 * 用同一批形状；键名判据补上复数与 cookie。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | EXP-RED-1 | 私钥块（PEM 头）出现在任意字段 ⇒ 被替换 |
 * | EXP-RED-2 | 连接串里的 `password=` ⇒ 被替换 |
 * | EXP-RED-3 | `Bearer <token>` ⇒ 被替换 |
 * | EXP-RED-4 | 复数键名 `apiKeys` / `tokens` ⇒ 值被替换 |
 * | EXP-RED-5 | `cookie` / `set-cookie` 键 ⇒ 值被替换 |
 * | EXP-RED-6 | 普通设置（标题、主题、数字）**不许**被误改（反向对照） |
 *
 * 变异自证：把 `redactCredentialShapes` 的形状表改回 `CREDENTIAL_VALUE_RES` ⇒ EXP-RED-1/2/3 红。
 */
import { describe, it, expect } from "vitest";
import { redactCredentialShapes } from "../core/settings/settings";

const redactedText = (v: unknown): string => JSON.stringify(redactCredentialShapes(v).value);

describe("导出脱敏：上下文形状", () => {
  it("EXP-RED-1: 私钥块必须被替换", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const out = redactCredentialShapes({ note: text });
    expect(out.redacted).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("EXP-RED-2: 连接串里的 password= 必须被替换", () => {
    const out = redactCredentialShapes({ db: "postgres://user:pw@host:5432/app?password=s3cret" });
    expect(out.redacted).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).not.toContain("s3cret");
  });

  it("EXP-RED-3: Bearer 令牌必须被替换", () => {
    const out = redactCredentialShapes({ header: "Authorization: Bearer abcDEF123456ghiJKLmnopQRST" });
    expect(out.redacted).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).not.toContain("abcDEF123456ghiJKLmnopQRST");
  });
});

describe("导出脱敏：键名判据", () => {
  it("EXP-RED-4: 复数键名 apiKeys / tokens 也要脱敏", () => {
    const out = redactCredentialShapes({
      apiKeys: ["short-gw-token-value"],
      tokens: { primary: "another-short-value" },
    });
    expect(out.redacted).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).not.toContain("short-gw-token-value");
    expect(JSON.stringify(out.value)).not.toContain("another-short-value");
  });

  it("EXP-RED-5: cookie / set-cookie 键要脱敏", () => {
    const out = redactCredentialShapes({
      cookie: "sid=abcdef123456",
      "set-cookie": "sid=abcdef123456; HttpOnly",
    });
    expect(out.redacted).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).not.toContain("abcdef123456");
  });

  it("EXP-RED-6（反向对照）: 普通设置不许被误改", () => {
    const input = {
      theme: "dark",
      fontSize: 14,
      modelName: "deepseek-chat",
      rightSidebarWidth: 360,
      enabled: true,
    };
    const out = redactCredentialShapes(input);
    expect(out.redacted, "普通设置里没有凭据").toBe(0);
    expect(out.value).toEqual(input);
    expect(redactedText(input)).toContain("deepseek-chat");
  });
});
