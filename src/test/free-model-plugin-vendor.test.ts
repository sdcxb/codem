/**
 * 第 201 波判据：免费模型插件的**内置副本与我们的补丁**。
 *
 * ## 为什么判据读的是 `tools/vendor/ofm/`（而不是 `src-tauri/resources/ofm/`）
 *
 * 内置副本**不进 git**：上游两个渠道包里内嵌了 Google OAuth 的 client id / client secret
 * （GitHub 推送保护当场拦下过这次推送），改成**构建时按固定 commit 现拉**
 * （`tools/vendor/fetch-ofm.mjs`，逐文件比对 `closure.json` 的 sha256）。
 * 于是仓库里能长期守住的东西是**溯源 + 补丁 + 哈希清单**这三样 —— 判据就守它们，
 * 这样在任何一台干净克隆上（含 CI，不联网、没拉副本）都成立。
 *
 * 若本机**已经拉过**副本（开发机 / 打包机），再额外断言"副本确实带着补丁" ⇒ 把
 * "拉了但忘打补丁"这种事也挡在门禁里。
 *
 * ## 这条判据守的是真机上踩过的坑
 *
 * 上游只在 `OPTIONS` 预检与 SSE 里发 CORS 头，**JSON 响应没有** ⇒ Codem 的界面（WebView2，跨源）
 * 取模型清单会被浏览器拦掉（`Failed to fetch`），而预检是通的 —— 真机上极容易被误判成
 * "服务没起来"（本波就误判过一次，最后靠子进程日志才定位）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const root = path.resolve(__dirname, "../..");
const META = path.join(root, "tools/vendor/ofm");
const DEST = path.join(root, "src-tauri/resources/ofm");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("OFM-VENDOR：内置副本的溯源、补丁与哈希清单", () => {
  it("OFM-VENDOR-1：补丁规格必须把 CORS 头补到 JSON 这条路上（并写明为什么）", () => {
    const spec = readJson(path.join(META, "patch-cors.json")) as {
      patches: Array<{ file: string; from: string; to: string; why: string }>;
    };
    const patch = spec.patches.find((p) => p.file === "src/forward.js");
    expect(patch, "找不到 forward.js 那条补丁").toBeTruthy();
    expect(patch!.from).toContain("function json(res, status, payload)");
    expect(patch!.to, "补丁必须给 json() 加上 corsHeaders()").toContain("...corsHeaders()");
    expect(patch!.to, "别把原来的 content-type 丢掉").toContain("'content-type': 'application/json'");
    expect(patch!.why, "why 要写清症状（否则后人会以为是多余的改动）").toContain("CORS");
  });

  it("OFM-VENDOR-2：溯源文件在（上游地址 + 固定 commit + 许可 + 为什么不进 git）", () => {
    const vendor = readJson(path.join(META, "VENDOR.json")) as {
      upstream?: string;
      commit?: string;
      license?: string;
      whyNotCommitted?: string;
    };
    expect(vendor.upstream).toContain("dsh-our-free-model");
    expect(vendor.commit, "必须锚定上游 commit（否则不知道内置的是哪一版）").toMatch(/^[0-9a-f]{40}$/);
    expect(vendor.license).toBe("MIT");
    expect(vendor.whyNotCommitted, "为什么内置副本不进 git 必须写下来（否则后人会又把它提交进去）").toContain("Google OAuth");
    expect(existsSync(path.join(META, "PATCHES.md")), "PATCHES.md 缺失 ⇒ 补丁的来龙去脉丢了").toBe(true);
  });

  it("OFM-VENDOR-3：哈希清单非空、与溯源同一个 commit（对不上就说明该重拉）", () => {
    const manifest = readJson(path.join(META, "closure.json")) as {
      commit?: string;
      fileCount?: number;
      files?: Record<string, string>;
    };
    const vendor = readJson(path.join(META, "VENDOR.json")) as { commit?: string };
    const files = manifest.files ?? {};
    const names = Object.keys(files);
    expect(names.length, "closure.json 是空的 ⇒ 构建时无从校验").toBeGreaterThan(50);
    expect(manifest.fileCount).toBe(names.length);
    expect(manifest.commit, "清单与溯源必须是同一个 commit").toBe(vendor.commit);
    for (const f of ["packages/standalone/cli.mjs", "packages/standalone/service.mjs", "src/forward.js"]) {
      expect(names, `清单里缺关键文件 ${f}`).toContain(f);
    }
    for (const [file, hash] of Object.entries(files)) {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${file} 的 sha256 形状不对`);
    }
  });

  it("OFM-VENDOR-4：本机若已拉取副本，它必须带着补丁与溯源文件", () => {
    if (!existsSync(DEST)) {
      /* 干净克隆（含 CI）：只校验上面三样，这是设计如此 */
      expect(existsSync(path.join(META, "VENDOR.json"))).toBe(true);
      return;
    }
    const forward = readFileSync(path.join(DEST, "src/forward.js"), "utf8");
    const jsonFn = forward.match(/function json\(res, status, payload\) \{[\s\S]{0,400}?\n\}/);
    expect(jsonFn, "找不到 json()（上游结构变了？）").toBeTruthy();
    expect(
      jsonFn![0].includes("...corsHeaders()"),
      "副本里的 json() 没有 CORS 头 ⇒ 浏览器会拦下 /health 与 /v1/models（预检却是通的）",
    ).toBe(true);
    expect(forward, "SSE 那条路的 CORS 头是上游自带的，不该被我们改掉").toContain("...corsHeaders(),\n    'content-type': 'text/event-stream");
    expect(existsSync(path.join(DEST, "VENDOR.json")), "副本里要有溯源文件").toBe(true);
    expect(existsSync(path.join(DEST, "PATCHES.md")), "副本里要有补丁说明").toBe(true);
  });
});
