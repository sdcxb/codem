/**
 * 「检查更新」判定与措辞的契约（第 62 轮）。
 *
 * 存在的理由是一个**假结论**：界面原来在 `check()` 没给出更新时**无条件显示**
 * 「已是最新版本」。而"没有更新"与"清单没读到"是两件事 ——
 * 后者在真机上真实发生过（`docs/RELEASE-GUIDE.md` 记录的 CDN 传播延迟，
 * 以及本会话里发布链路 `git push` / `gh release` 报 TLS 失败的那几次）。
 *
 * 用例把两个方向都钉住：**不许把"不知道"说成"最新"**，**不许安装比本机旧的清单**。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compareVersions, decideUpdate, parseVersion } from "../core/update/check-update";

const ROOT = join(__dirname, "..", "..");

describe("UPD：检查更新的判定与措辞", () => {
  it("UPD-0: 版本解析只认 x.y.z（读不出来就返回 null，不猜）", () => {
    expect(parseVersion("1.16.102")).toEqual([1, 16, 102]);
    expect(parseVersion("v1.16.102")).toEqual([1, 16, 102]);
    expect(parseVersion("1.16.102-beta.1")).toEqual([1, 16, 102]);
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(compareVersions("1.16.102", "1.16.99")).toBe(1);
    expect(compareVersions("1.16.99", "1.16.102")).toBe(-1);
    expect(compareVersions("1.16.102", "1.16.102")).toBe(0);
    expect(compareVersions("x", "1.0.0")).toBeNull();
  });

  it("UPD-1: 清单版本更高 ⇒ 安装，并且提示里带上具体版本", () => {
    const d = decideUpdate("1.16.102", "1.16.103");
    expect(d.kind).toBe("update");
    expect(d.message.zh).toContain("1.16.103");
    expect(d.message.en).toContain("1.16.103");
  });

  it("UPD-2: `check()` 返回 null（清单读到了、没有更高版本）⇒ 说「未发现更新」并提 CDN，不许断言「已是最新」", () => {
    for (const offered of [null, undefined, ""]) {
      const d = decideUpdate("1.16.102", offered);
      expect(d.kind).toBe("none");
      expect(d.message.zh.startsWith("未发现更新")).toBe(true);
      expect(d.message.zh, "刚发布时 CDN 可能还没同步 —— 这句必须说").toContain("CDN");
      expect(d.message.en).toContain("CDN");
      // 判据取"有没有断言绝对最新"：这句话里不许出现"已是最新"
      expect(d.message.zh.includes("已是最新")).toBe(false);
    }
  });

  it("UPD-3: 清单版本比本机旧（CDN 缓存的旧清单）⇒ **拒绝安装**并说明原因", () => {
    const d = decideUpdate("1.16.102", "1.16.101");
    expect(d.kind).toBe("anomaly");
    expect(d.message.zh).toContain("拒绝安装");
    expect(d.message.en.toLowerCase()).toContain("refused");
  });

  it("UPD-4: 清单版本与本机相同 ⇒ 「未发现更新」并报出这个版本（不说很新）", () => {
    const d = decideUpdate("1.16.102", "1.16.102");
    expect(d.kind).toBe("none");
    expect(d.message.zh).toContain("1.16.102");
    expect(d.message.zh).toContain("未发现更新");
    expect(d.message.zh.includes("已是最新")).toBe(false);
  });

  it("UPD-5: 版本号读不出来 ⇒ 归到 unknown（不许当成「有更新」去装）", () => {
    const d = decideUpdate("1.16.102", "latest");
    expect(d.kind).toBe("unknown");
    expect(d.offered).toBe("latest");
    expect(d.message.zh).toContain("读不出来");
  });

  it("UPD-6: 「检查更新」的文案必须由 React 渲染（不许再改 `textContent`）", () => {
    /**
     * 真机复量抓到的缺陷：文案原来是用 `btn.textContent = …` 直接改 DOM 的 ——
     * 只要组件因为**任何**原因重渲染一次，React 就会按 JSX 把文字写回"检查更新"，
     * 于是"发现新版本 / 未发现更新 / 更新失败: …"用户**根本看不到**
     * （控制台 `[updater] 未安装更新：none` 已经打了，界面上什么都没有）。
     *
     * 这条用例是**回归钉子**：文案必须来自 state（`updateMsg`），并且按钮的禁用态也走 state。
     */
    const src = readFileSync(join(ROOT, "src", "components", "SettingsPanel.tsx"), "utf8");
    const start = src.indexOf('id="check-update-btn"');
    expect(start, "找不到检查更新按钮（选择器变了？）").toBeGreaterThan(0);
    const block = src.slice(start, start + 4000);
    expect(block.includes("btn.textContent"), "检查更新按钮里不许再直接改 textContent").toBe(false);
    expect(block.includes("updateMsg"), "文案必须来自 state").toBe(true);
    expect(block.includes("disabled={updateBusy}"), "禁用态也必须走 state").toBe(true);
    expect(block.includes("setUpdateMsg"), "每次状态变化都要经过 setState").toBe(true);
  });
});
