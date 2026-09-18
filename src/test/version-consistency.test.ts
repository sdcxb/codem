/**
 * 版本号一致性（第 45 波 / 发布收尾时新增）。
 *
 * 背景：这个项目的版本号写在**三个**文件里 —— `package.json`、`src-tauri/tauri.conf.json`、
 * `src-tauri/Cargo.toml`。`docs/RELEASE-GUIDE.md` 明确要求"三处一起改"，但过去只有人工纪律，
 * 没有机器检查：漏改一处的后果是**安装包版本与前端显示的版本不一致**（updater 判断升级时会出错），
 * 而且这种错误在开发环境里完全看不出来。
 *
 * 这条测试把它变成机器约束：任何一次漏改都会在 CI/本地测试阶段直接失败。
 * 同时校验 CHANGELOG 顶部有对应版本的条目（发布说明不能只在代码里）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function readVersion(path: string): string {
  const text = readFileSync(join(ROOT, path), "utf8");
  const m = /version["'\s:=]+([0-9]+\.[0-9]+\.[0-9]+)/.exec(text);
  if (!m) throw new Error(`无法从 ${path} 解析版本号`);
  return m[1];
}

describe("发布 — 版本号一致性", () => {
  it("VERSION-1: package.json / tauri.conf.json / Cargo.toml 三处版本一致", () => {
    const pkg = readVersion("package.json");
    const tauri = readVersion("src-tauri/tauri.conf.json");
    const cargo = readVersion("src-tauri/Cargo.toml");
    expect(tauri, `tauri.conf.json(${tauri}) 与 package.json(${pkg}) 不一致`).toBe(pkg);
    expect(cargo, `Cargo.toml(${cargo}) 与 package.json(${pkg}) 不一致`).toBe(pkg);
  });

  it("VERSION-2: 版本号是合法的 semver 三段式", () => {
    const pkg = readVersion("package.json");
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("VERSION-3: CHANGELOG 顶部有当前版本的条目（发布说明不只在代码里）", () => {
    const pkg = readVersion("package.json");
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    // 取第一个版本标题（## [x.y.z]）作为"最新条目"
    const first = /^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m.exec(changelog);
    expect(first, "CHANGELOG 里找不到 `## [x.y.z]` 形式的版本条目").toBeTruthy();
    expect(first![1], `CHANGELOG 顶部是 ${first![1]}，但当前版本是 ${pkg}`).toBe(pkg);
  });

  it("VERSION-4: PROJECT-GUIDE 的「已发布版本」表里登记了当前版本", () => {
    const pkg = readVersion("package.json");
    const guide = readFileSync(join(ROOT, "docs/PROJECT-GUIDE.md"), "utf8");
    expect(guide.includes(`| v${pkg} |`), `docs/PROJECT-GUIDE.md 的已发布版本表里没有 v${pkg}`).toBe(true);
  });

  /**
   * ## VERSION-5：更新清单（`latest.json`）的**平台键**必须是 v2 的写法（第 54 轮）
   *
   * 真机查实的一整条坏链路：`latest.json` 一直写的是 **`platforms.windows`**
   * （Tauri **v1** 的写法），而 v2 的更新器找的是 `{os}-{arch}-{installer}` 与 `{os}-{arch}`
   * —— 也就是 `windows-x86_64-nsis` / `windows-x86_64`
   * （`tauri-plugin-updater-2.10.1/src/updater.rs:578-597`；`updater_os()` 返 "windows"、
   * `updater_arch()` 返 "x86_64"，同文件 1324-1351）。
   * 键对不上时更新器直接报
   * `None of the fallback platforms ["windows-x86_64"] were found in the response platforms object`
   * —— **「检查更新」这个功能从来没成功过**（界面上是诚实的"更新失败: …"，所以不是假成功，
   * 但功能一直是坏的）。
   *
   * 这条断言把"清单必须带正确的键"变成机器约束：以后谁把生成脚本改回 v1 写法，
   * 或者手改 `latest.json` 写漏了键，测试立刻红。
   *
   * ⚠️ 它**不**校验签名与 URL 是否与产物一致（那要跑一遍发布流程才知道）：
   * 这里只守"键在不在"这个最容易错、也最难在开发机上发现的点。
   */
  it("VERSION-5: latest.json 的平台键是 v2 写法（windows-x86_64 / windows-x86_64-nsis）", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "latest.json"), "utf8")) as {
      version: string;
      platforms: Record<string, { signature?: string; url?: string }>;
    };
    const keys = Object.keys(manifest.platforms ?? {});
    expect(
      keys,
      "更新器只认 `{os}-{arch}` 形式的键（v1 的 `windows` 永远找不到）—— " +
        `现在只有 ${JSON.stringify(keys)}`,
    ).toContain("windows-x86_64");
    expect(
      keys,
      "装了 NSIS 包时更新器**第一个**找的是 windows-x86_64-nsis（两把都要有才算写全）",
    ).toContain("windows-x86_64-nsis");
    expect(
      keys,
      "v1 的 `windows` 键不会让链路更兼容，只会让人误以为写全了 —— 不许留着",
    ).not.toContain("windows");

    for (const key of ["windows-x86_64", "windows-x86_64-nsis"]) {
      const entry = manifest.platforms[key];
      expect(entry.signature, `${key} 缺签名：更新器下载前要靠它验签`).toBeTruthy();
      expect(entry.url, `${key} 缺下载地址`).toBeTruthy();
      expect(entry.url!, `下载地址要指向本版本 ${manifest.version} 的安装包`).toContain(
        `v${manifest.version}/Codem_${manifest.version}_x64-setup.exe`,
      );
    }
  });
});
