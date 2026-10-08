/**
 * **凭据形状误报**的判据（第 49 波 ✓）—— 用户实报的那一条横幅 ✓。
 *
 * ## 现场（另一台机器，安装 skills 时 ✓）
 *
 * ```
 * [Maintenance] 凭据普查：73 个设置项里**明文**命中 9 处（codem-invariant-watermark(shape×9)）
 * [Advisory] maintenance.credentialCensus：设置里存在疑似凭据 9 处
 *            安全提示：发现疑似明文凭据 —— 这些是**明文存放的密钥/令牌** … 建议轮换
 * ```
 *
 * ## 根因（本文件把它钉住 ✓）
 *
 * 形状正则第一条原来是 `/sk-[A-Za-z0-9_-]{16,}/g` ✗ —— 两个口子 ✓：
 *   ① **没有前边界** ⇒ `ta`+`sk-…`、`ri`+`sk-…` 里的 `sk-` 都算密钥 ✓；
 *   ② **正文允许 `-`/`_`** ⇒ 路径与 ID 里的分隔符让"凑满 16 字符"轻而易举 ✓。
 * `codem-invariant-watermark` 是**水位记录**（本机 125 KB ✓，含会话/任务 id 与路径 ✓）
 * ⇒ 被整片误判成 9 处明文密钥 ✗，并向用户建议"轮换密钥" ✗。
 *
 * 本文件既钉住"**新判据不再误报**" ✓，也用**旧正则**做反例对照 ✓（证明这确实是那条类 ✓），
 * 并钉住"**真令牌仍然要报**" ✓（不许为了消误报把能力改瞎 ✗）。
 *
 * ## 第 188 波 R5：形状口径收敛到唯一来源，本文件两处断言**如实跟着变**
 *
 * 收口前 `sk-` 形状有**四份**实现（普查/导出脱敏、记忆与日志脱敏、两处工具参数扫描），
 * 现在只有一份（`core/utils/credential-shapes.ts`，见 `credential-shape-single-source.test.ts`）。
 * 因此：
 *  - `FP-5` 的形状名由 `sk-` 改成 `sk-/pk-`（共享来源的强前缀**同时**覆盖 `sk-` 与 `pk-`）；
 *  - `FP-6` 由"前边界必须是 `(?<![A-Za-z0-9])`"改成"必须有前/后边界 **且强前缀的前边界必须排除
 *    `-`/`_`**"—— 后者是**加强**：修复前普查那条前边界放行 `-`，`task-sk-…` 照样被报成凭据（实测）。
 */
import { describe, expect, it } from "vitest";

import { censusCredentialSettings } from "../core/storage/credential-census";
import { CREDENTIAL_VALUE_RES, redactCredentialShapes } from "../core/settings/settings";

/** 旧判据（**仅供反例对照** ✓：证明"这类内容会被它打中" ✓，不是要用的判据 ✗） */
const OLD_SK_RE = /sk-[A-Za-z0-9_-]{16,}/g;

/** 与报错机器同构的水位内容 ✓：任务 id、风险 id、Windows 路径 ✓ */
const WATERMARK_LIKE = JSON.stringify({
  "task-1791179367418-8e8ynxu9b": { lastSeen: "D:\\方案类项目\\制造运营管控agent标准\\集中办公材料\\申报答辩" },
  "risk-abc12345678901234567890": { count: 3 },
  "task-1789315125123-1qi3gz9mt": { lastSeen: "D:\\方案类项目\\制造运营管控agent标准" },
  "misc-1791216907054-29832": { count: 7 },
});

const REAL_SK = "sk-abcdefghijklmnopqrstuvwxyz012345";
const REAL_GHO = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REAL_AKIA = "AKIAIOSFODNN7EXAMPLE";

describe("凭据形状误报（第 49 波 ✓）", () => {
  it("FP-1 ★ 水位/路径这类内容**不再**被判成明文凭据 ✓（用户实报的那条 ✓）", () => {
    // 先用旧判据证明"这类内容确实会被打中" ✓ —— 否则本用例可能只是在测空气 ✗
    const oldHits = (WATERMARK_LIKE.match(OLD_SK_RE) ?? []).length;
    expect(oldHits, "反例对照：旧判据必须真的会命中（否则这条修复就没有对象 ✗）").toBeGreaterThan(0);

    const out = censusCredentialSettings([{ key: "codem-invariant-watermark", value: WATERMARK_LIKE }]);
    expect(out.total, "★ 修好之后必须 0 命中 ✓").toBe(0);
    expect(out.hits.map((h) => h.key)).not.toContain("codem-invariant-watermark");
  });

  it("FP-2 真令牌**仍然要报** ✓（不许为消误报把能力改瞎 ✗）", () => {
    const out = censusCredentialSettings([
      { key: "note", value: `排查：${REAL_SK} 与 ${REAL_GHO} 与 ${REAL_AKIA}` },
    ]);
    expect(out.total, "三种真令牌都被打中").toBe(3);
    expect(JSON.stringify(out), "值仍然绝不外泄 ✓").not.toContain(REAL_SK);
  });

  it("FP-3 ★ 导出脱敏**不再改写**路径/ID 片段 ✓（同一份正则的第二个出口 ✓）", () => {
    const before = redactCredentialShapes({ wm: WATERMARK_LIKE }).redacted;
    expect(before, "★ 旧写法会把 task-… 片段改写成 sk-*** ⇒ 导出内容被破坏 ✗").toBe(0);
    const out = redactCredentialShapes({ note: `token=${REAL_SK}` });
    expect(out.redacted, "真令牌必须照旧被脱敏 ✓").toBe(1);
    expect(JSON.stringify(out.value)).not.toContain(REAL_SK);
  });

  it("FP-4 边界：令牌必须是一整段 ✓（前面多一个字母就不算 ✓）", () => {
    expect(censusCredentialSettings([{ key: "n", value: `x${REAL_SK}` }]).total, "xsk-… 不是独立令牌").toBe(0);
    expect(censusCredentialSettings([{ key: "n", value: `x${REAL_AKIA}` }]).total, "xAKIA… 不是独立令牌").toBe(0);
  });

  it("FP-5 命中的**形状名**要能看见 ✓（这次误报难判就是因为只印了 shape×9 ✗）", () => {
    const out = censusCredentialSettings([{ key: "n", value: `a ${REAL_SK} b ${REAL_AKIA}` }]);
    const shape = out.hits.find((h) => h.kind === "shape");
    expect(shape, "应有形状命中").toBeTruthy();
    /**
     * ⚠️ 第 188 波 R5 **如实改名** ✓：这条形状原来叫 `sk-`，现在是共享来源里的 `apiKeyStrong`
     * —— 它的强前缀是 **`sk-` 与 `pk-` 两个**（改名之前普查只认 `sk-`，而脱敏那份认两个 ⇒
     * 同一规则两份实现）。名字必须跟着形状走，否则日志里那句"命中的是哪一种形状"又是假的。
     */
    expect(shape!.shapes?.join(","), "要能说清是哪几种形状").toContain("sk-/pk-×1");
    expect(shape!.shapes?.join(",")).toContain("AKIA×1");
  });

  it("FP-6 每一条形状正则都自带两侧边界 ✓（防止有人把边界改回去 ✗）", () => {
    for (const re of CREDENTIAL_VALUE_RES) {
      expect(re.source, `少了前边界：${re.source}`).toMatch(/^\(\?<!/);
      expect(re.source, `少了后边界：${re.source}`).toMatch(/\(\?!\[A-Za-z0-9[^\]]*\]\)$/);
    }
    /**
     * ⚠️ 第 188 波 R5 补强 ✓：强前缀的前边界**必须排除 `-`/`_`** —— 只写 `(?<![A-Za-z0-9])`
     * 会放行 `-`，于是 `task-sk-…` 里那个 `sk-` 照样命中（修复前实测：普查把
     * `C:\work\task-sk-…\src\index.ts` 报成明文凭据 ✗，判据 `CS-PATHS` 修复前红）。
     * `risk-sk-…` 由 `k` 挡住，`task-sk-…` 由 `-` 挡住 —— 两条都要，缺一条就是误报。
     */
    const strong = CREDENTIAL_VALUE_RES.find((re) => re.source.includes("(?:sk|pk)"));
    expect(strong, "强前缀（sk-/pk-）形状必须在表里").toBeTruthy();
    expect(
      strong!.source.startsWith("(?<![A-Za-z0-9_-])"),
      `强前缀的前边界必须排除 -/_（否则 task-sk-… 会被当成凭据）：${strong!.source}`,
    ).toBe(true);
  });
});
