/**
 * ★ 第 187 波（真机事故回归判据）：**`src-tauri/src/bin/` 下不许有任何文件**。
 *
 * ## 事故现场
 *
 * `.cmd` 引号修复的判据需要一个"只有 main、不链接 libtest"的小探针，于是放进了
 * `src-tauri/src/bin/argv_probe.rs`。Cargo 会**自动发现** `src/bin/*.rs` 为**额外的 binary target**，
 * Tauri 打包时把它当成要装的东西 ⇒ 装机后 `%LOCALAPPDATA%\Codem` 里出现 `argv_probe.exe`，
 * 而 **`codem.exe` 不见了**（应用被这次安装弄坏：安装器退出码 0，但主程序没装进去）。
 *
 * 环境不变量：一个"多出来的 bin target"能把打包结果整个带偏，而且**构建与安装都不报错**。
 * 所以这里用一条判据把它钉死：探针这类**只给判据用**的小程序必须放在不会被 Cargo 自动发现的位置
 * （当前是 `src-tauri/probe-src/`），`src/bin/` 必须为空/不存在。
 *
 * 判据之所以放在 TS 侧：它检查的是**仓库布局**，与 Rust 编译无关，放在这里跑得更早也更便宜。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BIN_DIR = join(ROOT, "src-tauri", "src", "bin");

describe("第 187 波 · 打包布局不变量（探针不许成为 bin target）", () => {
  it("PKG-1: `src-tauri/src/bin/` 必须不存在或为空（否则 Cargo 会自动发现成额外 bin，打歪安装包）", () => {
    if (!existsSync(BIN_DIR)) return; // 不存在 = 最干净
    const entries = readdirSync(BIN_DIR);
    expect(
      entries,
      `src-tauri/src/bin/ 下有文件 ⇒ Cargo 会把它们当**额外 binary target**，Tauri 打包可能把主程序挤掉（真机事故：装完只有 argv_probe.exe、没有 codem.exe）。请把这类"只给判据用"的小程序移到 src-tauri/probe-src/。`,
    ).toEqual([]);
  });

  it("PKG-2: 判据用的探针必须真在 probe-src/ 下（防止有人只删 src/bin 又把探针弄丢）", () => {
    expect(
      existsSync(join(ROOT, "src-tauri", "probe-src", "argv_probe.rs")),
      "argv 探针必须存在于 src-tauri/probe-src/argv_probe.rs（判据会现场用它编译）",
    ).toBe(true);
  });

  it("PKG-3: `tauri.conf.json` 没被加上会把额外 bin 打进包里的配置（externalBin/resources 指向探针）", () => {
    const conf = require("node:fs").readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8");
    expect(conf, "不许把探针配成 externalBin / bundle 资源").not.toMatch(/argv_probe/);
  });
});
