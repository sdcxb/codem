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
});
