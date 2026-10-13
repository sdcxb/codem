/**
 * 第 208 波收尾判据（用户实报的两条）：
 * ① 设置里点「Our Free Model（免费模型插件）」的『刷新模型列表』，仍然提示「请先配置 API Key」；
 * ② 对话报 `Provider stream error: Upstream request failed: Endpoint is unavailable.` ——
 *    真机体测（25 个免费模型逐个体测）证明这是**上游侧**的模型级失败（同一次会话里
 *    mimo-v2.6-flash-free / nemotron-3.5-lightning-free / longcat-2.5-preview-free 都正常），
 *    所以文案必须给出"换一个免费模型"这个下一步，而不是让用户去查自己的 Key 或网络。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

describe("OFM-REFRESH-HINT：刷新按钮与上游失败的文案", () => {
  it("OFM-REFRESH-HINT-1（结构棘轮）：托管供应商要能刷新，且必须带**插件运行时那把 Key**", () => {
    const panel = readFileSync(path.join(root, "src/components/SettingsPanel.tsx"), "utf8");
    expect(panel, "要认出托管条目").toContain('managedBy === "free-model-plugin"');
    expect(panel, "刷新闸门要放行它（它没有、也不该有用户配的 Key）").toMatch(/!authKey && !isManagedFreeModel/);
    /*
     * 第 209 波真机教训：放行之后**省略 Authorization** ⇒ 插件那个本机服务回 401
     * ⇒ 用户看到「获取失败，使用内置列表」。密钥在插件自己的 settings.json 里，必须现读现用。
     */
    expect(panel, "密钥要从插件诊断口现读").toContain("freeModelPlugin.diagnostics.runtime()");
    expect(panel, "并且真的带上 Authorization").toContain("Bearer ${authKey}");
    /*
     * 只断言"有那段字"是不够的（变异把它改成"有条件才带"照样绿）—— 真机上就是这么坏的：
     * 托管供应商没有 apiKey，条件不成立 ⇒ 等于没带 ⇒ 401。所以这里否定"把它条件化"这个形态。
     */
    expect(panel, "托管那次刷新必须**无条件**带 Authorization").not.toMatch(
      /authKey && provider\.apiKey \? \{ Authorization/,
    );
    /*
     * 第 227 波（用户实报）：这里原来断言的是「插件未运行…插件市场」—— 而那张卡片**不在**
     * 插件市场页签里（它在「插件管理 → Our Free Model」）。判据跟着改成"必须指向真实位置"，
     * 并**反向**钉住"不许再提插件市场"（指错地方比不说更糟：用户会去一个找不到卡片的地方找）。
     */
    expect(panel, "读不到密钥时说「插件未运行」，不许让用户去配一个配不出来的 Key").toMatch(
      /插件未运行[\s\S]{0,120}Our Free Model/,
    );
    expect(panel, "并且要给出那颗真的能解决问题的按钮名").toContain("结束残留进程并重试");
    expect(panel, "**不许**再把用户指去「插件市场」（那张卡片不在那儿）").not.toMatch(
      /插件未运行[\s\S]{0,120}插件市场/,
    );
  });

  it("OFM-REFRESH-HINT-2（结构棘轮）：上游免费模型失败要给出「换一个」的下一步", () => {
    const provider = readFileSync(path.join(root, "src/core/llm/provider.ts"), "utf8");
    expect(provider, "要认出上游那几种原话").toMatch(/endpoint is unavailable/i);
    expect(provider, "要说明这是上游侧、不是 Codem").toContain("不是 Codem");
    expect(provider, "要点出报错的模型名").toMatch(/当前模型：\$\{request\.model\}/);
    expect(provider, "要给可操作的下一步").toContain("换一个");
  });
});
