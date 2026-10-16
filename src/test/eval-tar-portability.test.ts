/**
 * **评测脚手架的可移植性**判据（2026-10-16）。
 *
 * ## 守的缺陷
 *
 * `tools/eval/repo-workspace.mjs` 原来用 `spawnSync("tar", ["-xf", tar, "-C", ws])`，
 * 而 `tar` 是 `os.tmpdir()` 下的 **Windows 绝对路径**（`C:\Users\…\x.tar`）。
 * GNU tar 把 `-f HOST:PATH` 当**远程归档** ⇒
 *
 * ```text
 * tar: Cannot connect to C: resolve failed
 * ```
 *
 * ⇒ `node tools/eval/run-repo-arm.mjs --verify-workspace`（`npm run audit` 的
 * `eval:repo-workspace` 那一步）在 **GNU tar 排在 PATH 前面**的环境里必挂。
 * 本机踩到：DSH 的 bash 前置了 `@dsh-ops/bash-win32-…/ucrt64/bin`（GNU tar 1.35），
 * 而 `C:\Windows\System32\tar.exe` 是 bsdtar 3.8.9（按 Windows 路径处理）
 * ⇒ 宿主 PowerShell 里一直不暴露，换到 bash 就必红。
 *
 * ## 判据
 * | # | 行为 |
 * |---|---|
 * | TP-1 | **功能**：在 Windows 绝对路径上建包 → `untarInto()` 必须真的解开（这条在本机就是 GNU tar 环境，正是原先必挂的形态） |
 * | TP-2 | **静态**：`tools/**`、`scripts/**` 里不许再出现"把绝对路径直接喂给 `-f`"的写法，也不许出现只在一个 tar 实现下成立的方言 |
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { untarInto } from "../../tools/eval/repo-workspace.mjs";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = process.cwd();

describe("评测脚手架的可移植性（tar）", () => {
  it("TP-1: Windows 绝对路径上的归档必须能被 untarInto 解开（GNU tar 环境下的原失败形态）", () => {
    const dir = mkdtempSync(join(tmpdir(), "codem-tar-portability-"));
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "probe.txt"), "hello-portability", "utf8");

    // 建包也用可移植形状：`-f` 裸名 + cwd，`-C` 转正斜杠（实测矩阵见 untarInto 的注释）
    const pack = spawnSync("tar", ["-cf", "probe.tar", "-C", src.replace(/\\/g, "/"), "."], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(pack.status, `建包失败：${pack.stderr || pack.stdout}`).toBe(0);
    const tarPath = join(dir, "probe.tar");
    expect(existsSync(tarPath), "前置条件：包必须真的建出来").toBe(true);

    try {
      const untar = untarInto(tarPath, dst);
      expect(
        untar.status,
        "在 Windows 绝对路径上解开归档必须成功。原先的 ['-xf', <绝对路径>, …] 在 GNU tar 下会报 " +
          `"tar: Cannot connect to C: resolve failed"（stderr=${untar.stderr || untar.stdout}）`,
      ).toBe(0);
      expect(readFileSync(join(dst, "probe.txt"), "utf8")).toBe("hello-portability");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TP-2: 静态扫描 —— 不许再把绝对路径喂给 tar 的 -f，也不许用某一种 tar 的方言", () => {
    /**
     * 只在一个 tar 实现下成立的写法（本机的两个实现：GNU tar 1.35 / bsdtar 3.8.9）：
     * - `--force-local`：GNU 专有（要求两个实现都能跑就不许用）；
     * - `sed -i`：GNU/BSD 语义不同（BSD 需要 `-i ''`）；
     * - `find -printf`：GNU 专有；
     * - `sha256sum -c`：Windows 上通常只有 `certutil`/`Get-FileHash`。
     *
     * 例外表为空 —— 有例外就逐条写理由（并要求例外被真的用到）。
     */
    const DIALECTS: Array<{ pattern: RegExp; what: string }> = [
      { pattern: /--force-local/, what: "--force-local（GNU 专有）" },
      { pattern: /\bsed\s+-i/, what: "sed -i（GNU/BSD 语义不同）" },
      { pattern: /\bfind\b[^\n]*-printf\b/, what: "find -printf（GNU 专有）" },
      { pattern: /\bsha256sum\s+-c\b/, what: "sha256sum -c（Windows 上没有）" },
    ];

    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|js|ts)$/.test(e.name)) files.push(p);
      }
    };
    walk(join(ROOT, "tools"));
    walk(join(ROOT, "scripts"));
    expect(files.length, "必须真的扫到脚本（否则这条判据没有对象）").toBeGreaterThan(20);

    const dialectHits: string[] = [];
    const unportableTar: string[] = [];
    for (const f of files) {
      // 先剥注释：注释里**提到**这些方言是正当的（例如解释"为什么不用 --force-local"），
      // 判据要抓的是**真的用了**（不加这一步，判据会被自己的说明文字判红）。
      const text = stripComments(readFileSync(f, "utf8"));
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      for (const { pattern, what } of DIALECTS) {
        if (pattern.test(text)) dialectHits.push(`${rel}: ${what}`);
      }
      /**
       * tar 调用的形状检查：把 `tar` + `-xf` 那一小段（含后续 120 字符）抠出来看。
       * 允许的两种形状：
       *   · `-xf <裸文件名>` 且同一调用里给了 `cwd`；
       *   · `-xf <字符串字面量>`（字面量里没有路径分隔符/盘符）。
       * 其余（尤其把 `join(tmpdir(), …)` 这种绝对路径变量直接喂进去）一律记红。
       */
      for (const m of text.matchAll(/["']tar["'][\s\S]{0,200}?["']-xf["']\s*,\s*([^,\n]+)/g)) {
        const arg = m[1];
        const window = m[0];
        const literal = arg.startsWith('"') || arg.startsWith("'");
        const literalIsPlain = literal && !/[\\/]/.test(arg);
        const hasCwd = /cwd\s*:/.test(window);
        const usesBasename = /\bbasename\s*\(/.test(arg);
        if (literalIsPlain || usesBasename || hasCwd) continue;
        unportableTar.push(`${rel}: 把 ${arg} 直接喂给 tar -f（GNU tar 会当成 HOST:PATH 远程归档）`);
      }
    }

    expect(unportableTar, "tar 调用必须用「裸文件名 + cwd」或「不含路径的字面量」").toEqual([]);
    expect(dialectHits, "这些写法只在某一个 tar/sed/find 实现下成立（换到 GNU tar 或 Windows 就挂）").toEqual([]);
  });
});
