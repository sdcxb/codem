/**
 * STACK-MARKET：stack 索引 + 从**真实技能市场**解析安装。
 *
 * 钉住：
 * 1. 索引解析只收合法条目（坏条目/重复名丢弃，不阻塞其它包）；
 * 2. 技能按名字大小写不敏感匹配；市场里没有 → missing（不猜替代品）；
 * 3. 单个技能安装失败 → failed，不中断其它技能；
 * 4. 索引不是 JSON → 抛（市场不可用要可见，不静默空列表）。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchStackIndex, installStackFromMarket, STACK_INDEX_URL } from "../core/skill/stack-market";

const signed = { verifySignature: async () => true, httpGetSignature: async () => "sig" };

const indexBody = JSON.stringify({
  schemaVersion: 1,
  stacks: [
    { name: "review-pack", version: "1.0.0", skills: ["code-review", "missing-skill"] },
    { name: "review-pack", version: "9.9.9", skills: ["dup"] },
    { name: "broken", version: "1.0.0", skills: [] },
    { name: "bad-version", skills: ["code-review"] },
  ],
});

describe("STACK-MARKET", () => {
  it("SM-1: Release 资产缺失时回退 master；索引只保留合法且不重名的条目", async () => {
    const httpGet = vi.fn(async (url: string) => {
      if (url.includes("releases/latest")) throw new Error("HTTP 404");
      return indexBody;
    });
    const entries = await fetchStackIndex({ httpGet, ...signed });
    expect(httpGet).toHaveBeenCalledWith(STACK_INDEX_URL);
    expect(entries.map((e) => e.name)).toEqual(["review-pack"]);
    expect(entries[0].skills).toEqual(["code-review", "missing-skill"]);
  });

  it("SM-2: 安装时逐个解析；missing/failed 分开记，不中断", async () => {
    const listSkills = vi.fn(async () => ({
      skills: [{ name: "Code-Review", installType: "builtin" } as any],
      errors: [],
    }));
    const installSkill = vi.fn(async () => ({ success: true }));
    const r = await installStackFromMarket("review-pack", {
      httpGet: async () => indexBody,
      ...signed,
      listSkills: listSkills as any,
      installSkill: installSkill as any,
    });
    expect(r.name).toBe("review-pack");
    expect(r.installed).toEqual(["code-review"]);
    expect(r.missing).toEqual(["missing-skill"]);
    expect(r.failed).toEqual([]);
    expect(installSkill).toHaveBeenCalledTimes(1);

    installSkill.mockResolvedValueOnce({ success: false, error: "zip 坏了" } as any);
    const r2 = await installStackFromMarket("review-pack", {
      httpGet: async () => indexBody,
      ...signed,
      listSkills: listSkills as any,
      installSkill: installSkill as any,
    });
    expect(r2.failed).toEqual([{ name: "code-review", error: "zip 坏了" }]);
  });

  it("SM-3: 索引不是 JSON / 包不存在 → 明确抛错", async () => {
    await expect(fetchStackIndex({ httpGet: async () => "<html>", ...signed })).rejects.toThrow(/不是合法 JSON/);
    await expect(
      installStackFromMarket("nope", {
        httpGet: async () => indexBody,
      ...signed,
        listSkills: async () => ({ skills: [], errors: [] }) as any,
      }),
    ).rejects.toThrow(/不存在/);
  });

  it("SM-4: 验签失败/缺签名 → 拒绝加载", async () => {
    await expect(
      fetchStackIndex({ httpGet: async () => indexBody, httpGetSignature: async () => "sig", verifySignature: async () => false }),
    ).rejects.toThrow(/签名无效/);
    await expect(
      fetchStackIndex({ httpGet: async () => indexBody, httpGetSignature: async () => { throw new Error("404"); } }),
    ).rejects.toThrow(/签名缺失/);
  });});
