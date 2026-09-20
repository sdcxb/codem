/**
 * UPD-MANIFEST —— `latest.json` **生成器**的回归（不只是产物）。
 *
 * ## 为什么必须测生成器（这是本轮抓到的一个真缺陷）
 *
 * 仓库里有两份"生成 latest.json"的东西：
 *  - **被跟踪的** `tools/release/make-latest-json.mjs`：写 `platforms.windows`（Tauri **v1** 写法）；
 *  - **没入库**的 `.preview-shot/_audit/make-latest-json.mjs`：写对了 v2 的
 *    `windows-x86_64-nsis` / `windows-x86_64`，**发布时实际用的是它**。
 *
 * v2 更新器只找 `{os}-{arch}-{installer}` 与 `{os}-{arch}` 两个键
 * （`tauri-plugin-updater-2.10.1/src/updater.rs:578-597`），所以照那个**被跟踪的**工具跑一次，
 * 「检查更新」就会报 `None of the fallback platforms [...] were found` —— 而且是**静默**的
 * （产物看起来正常、签名也在）。
 *
 * 既有的 `version-consistency.test.ts` 的 VERSION-5 **只校验产物 `latest.json`**，
 * 对"生成器写错"完全无感：这正是"两个真相来源"的形态。所以这里：
 *  ① 校验**构造器**（`tools/release/latest-json.mjs` 的纯函数）输出的键与自检；
 *  ② **真的跑一遍 CLI**（写到临时文件），断言它写出来的东西是对的 —— 测生成器本身；
 *  ③ 扫 `tools/` 下**不许再有**第二份写 v1 键的构造逻辑。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLatestManifest, validateLatestManifest, assetUrl, REQUIRED_PLATFORM_KEYS } from "../../tools/release/latest-json.mjs";

const ROOT = join(__dirname, "..", "..");
const SIG = "untrusted comment: signature from tauri secret key\nAAAAfake+signature+for+test==\n";

describe("UPD-MANIFEST latest.json 生成器", () => {
  it("UPD-MANIFEST-1：构造器写 v2 的两个键、**不写** v1 的 `windows`", () => {
    const m = buildLatestManifest({ version: "9.9.9", signature: SIG, notes: "x" });
    expect(Object.keys(m.platforms).sort()).toEqual([...REQUIRED_PLATFORM_KEYS].sort());
    expect(m.platforms.windows, "v1 的 windows 键永远读不到，不许当兼容留着").toBeUndefined();
    expect(m.version).toBe("9.9.9");
    expect(m.platforms["windows-x86_64"].url).toBe(assetUrl("9.9.9"));
    expect(m.platforms["windows-x86_64"].url).toContain("v9.9.9");
    expect(validateLatestManifest(m, { version: "9.9.9" })).toEqual([]);
  });

  it("UPD-MANIFEST-2：自检必须能**报出**错清单（否则它就是个摆设）", () => {
    const bad = buildLatestManifest({ version: "9.9.9", signature: SIG });
    // ① 少一个键
    const missing = { ...bad, platforms: { "windows-x86_64": bad.platforms["windows-x86_64"] } };
    expect(validateLatestManifest(missing, { version: "9.9.9" }).join("|")).toMatch(/缺平台键 windows-x86_64-nsis/);
    // ② 混进 v1 键
    const v1 = { ...bad, platforms: { ...bad.platforms, windows: bad.platforms["windows-x86_64"] } };
    expect(validateLatestManifest(v1, { version: "9.9.9" }).join("|")).toMatch(/v1/);
    // ③ 签名空 / URL 版本不符
    const noSig = { ...bad, platforms: { ...bad.platforms, "windows-x86_64": { signature: "  ", url: "https://x/1" } } };
    const p = validateLatestManifest(noSig, { version: "9.9.9" }).join("|");
    expect(p).toMatch(/缺签名/);
    expect(p).toMatch(/没有版本号/);
    // ④ 版本不符
    expect(validateLatestManifest(bad, { version: "1.0.0" }).join("|")).toMatch(/version 是 9\.9\.9/);
    // ⑤ 构造器拒绝带 v 前缀（`v1.2.3` 会拼出 `vv1.2.3` 这种下载地址）
    expect(() => buildLatestManifest({ version: "v9.9.9", signature: SIG })).toThrow(/不该带 v 前缀/);
    expect(() => buildLatestManifest({ version: "9.9.9", signature: " " })).toThrow(/缺 signature/);
  });

  it("UPD-MANIFEST-3：**真的跑一遍 CLI**（临时签名 + 临时输出），产物必须是 v2 键且无 BOM", () => {
    const dir = mkdtempSync(join(tmpdir(), "codem-manifest-"));
    const sigPath = join(dir, "Codem_9.9.9_x64-setup.exe.sig");
    const outPath = join(dir, "latest.json");
    writeFileSync(sigPath, SIG, "utf8");
    const stdout = execFileSync(
      process.execPath,
      [join(ROOT, "tools/release/make-latest-json.mjs"), "9.9.9", "自测说明", "--sig", sigPath, "--out", outPath],
      { cwd: ROOT, encoding: "utf8" },
    );
    const bytes = readFileSync(outPath);
    expect(bytes.subarray(0, 3).toString("hex"), "带 BOM 的清单会让更新器解析失败").not.toBe("efbbbf");
    const m = JSON.parse(bytes.toString("utf8"));
    expect(Object.keys(m.platforms).sort()).toEqual([...REQUIRED_PLATFORM_KEYS].sort());
    expect(m.notes).toBe("自测说明");
    expect(stdout).toMatch(/无 BOM=✓/);
  });

  it("UPD-MANIFEST-4：签名文件不存在时**拒绝生成**（不许产出一份没签名的清单）", () => {
    const dir = mkdtempSync(join(tmpdir(), "codem-manifest-missing-"));
    let failed = null;
    try {
      execFileSync(
        process.execPath,
        [join(ROOT, "tools/release/make-latest-json.mjs"), "9.9.9", "--sig", join(dir, "nope.sig"), "--out", join(dir, "latest.json")],
        { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
      );
    } catch (e) {
      failed = e;
    }
    expect(failed, "缺签名必须非 0 退出").not.toBeNull();
    expect(String(failed.stdout) + String(failed.stderr)).toMatch(/找不到签名文件/);
  });

  it("UPD-MANIFEST-5（反向守卫）：`tools/` 下不许再有第二份写 v1 平台键的构造逻辑", () => {
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(mjs|js|cjs)$/.test(name)) {
          const src = readFileSync(p, "utf8");
          // 只抓"构造 platforms 时把 windows 当键"的形态（注释里提到 windows 不算）
          if (/platforms:\s*\{[^}]*\bwindows\s*:/.test(src)) hits.push(p.replace(ROOT, "").replace(/\\/g, "/"));
        }
      }
    };
    walk(join(ROOT, "tools"));
    expect(hits, "v1 写法的清单生成逻辑又出现了 —— 它会让「检查更新」永远失败").toEqual([]);
  });

  it("UPD-MANIFEST-6：**入库的那份 `latest.json`** 与当前版本一致且键齐全（产物与生成器对齐）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(ROOT, "latest.json"), "utf8"));
    expect(manifest.version).toBe(pkg.version);
    expect(validateLatestManifest(manifest, { version: pkg.version })).toEqual([]);
  });
});
