/**
 * `BYTES-SINGLE-SOURCE`：**字节数的人读形态只许有一份实现**（第 191 波，全仓搜同类的产物）。
 *
 * ## 为什么这条判据必须存在（本仓的惯性）
 *
 * 本轮按纪律做「发现同类就全仓搜同类」时，在 `src/**` 里找到 **8 份**「字节数 → 人读字符串」的实现，
 * 而且有 **4 种不同口径**：
 *
 * | 位置 | 2048 字节 | 5 MiB |
 * | --- | --- | --- |
 * | `components/InputArea.tsx`（本地 `formatSize`） | `2.0 KB` | `5.0 MB` |
 * | `components/MessageBubble.tsx`（本地 `formatSize`） | `2.0 KB` | `5.0 MB` |
 * | `core/storage/maintenance.ts`（本地 `formatBytes`） | `2.0 KiB` | `5.0 MiB` |
 * | `plugins/library-ops/core/scene-image.ts`（导出 `formatBytes`） | `2.0KB` | `5.00MB` |
 * | `components/NotebookWorkspace.tsx`（内联） | `2.0KB` | `5120.0KB`（单位错到看不出来） |
 * | `core/skills/skill-creator/scripts/package-skill.ts`（内联 `sizeKB`） | `2.0 KB` | `5120.0 KB` |
 * | `core/skills/skill-creator/scripts/quick-validate.ts`（内联） | `2.0KB` | `5120.0KB` |
 * | `core/storage/maintenance.ts`（**同一文件第二处**，`/ 1048576`） | —— | `5.0 MB` |
 *
 * 同一个数在维护汇总里写 `4.0 MiB`、在附件气泡里写 `4.0 MB` —— 用户与审计无法一眼判断
 * 两处说的是不是同一件事。本仓对「同一事实两套口径」的判断一贯是 P1
 * （第 189 波的相对亮度阈值 `0.04045 / 0.03928` 就是同一形态）。
 *
 * ## 判据
 *
 * - `BYTES-1`（解析式对账 + 例外表不许过期）：`src/**`（`src/test/**` 是夹具，不算产品口径）里
 *   凡是**同时**命中「字节换算」与「字节单位词」的文件，必须是**唯一实现**
 *   （`src/core/utils/bytes.ts`）或登记在例外表里；例外表里每条都要真的命中。
 * - `BYTES-1b`（防恒真）：把判定谓词对**已知的历史形态**逐条验证（旧实现必须被判红、
 *   合法用法必须不被判红）——否则"扫了个空"也会绿。
 * - `BYTES-2`（行为）：唯一实现的口径被钉住（0 / 512 / 2048 / 5 MiB / 2 GiB + 非有限值），
 *   且 `scene-image.ts` 的再导出**就是**同一份函数（不是"看起来一样"）。
 * - 反向对照（改回本地实现 ⇒ BYTES-1 红；改口径 ⇒ BYTES-2 红）由
 *   `tools/mutate/specs/bytes-191.json` 证明。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { formatBytes, megabytesOf } from "../core/utils/bytes";
import { formatBytes as formatBytesFromPlugin } from "../plugins/library-ops/core/scene-image";

const ROOT = process.cwd();
/** **唯一实现**（"字节数 → 人读字符串 / MB 数字"的唯一出处） */
const SINGLE_SOURCE = "src/core/utils/bytes.ts";

/**
 * **例外表**（每条都必须真的命中，且必须写明"为什么它不是同一条规则"）。
 *
 * 目前**为空**：全仓 8 处副本已全部收敛到唯一实现，包括原来那个输出**数字**的
 * `core/diagnostics/renderer-evidence.ts`（它现在调 `megabytesOf`）。
 * 这张表刻意保留：将来真出现"看起来像但确实不是同一条规则"的形态时，
 * 要在这里写理由 —— 而"表不许过期"的断言会保证它不会悄悄失效。
 */
const EXCEPTIONS: Array<{ file: string; reason: string }> = [
  {
    file: "src/core/skills/skill-creator/scripts/quick-validate.ts",
    reason:
      "技能脚本会被 SkillInstaller **整份复制进技能目录**（~/.codem/skills/<name>/scripts/），那里没有应用源码树 ⇒ 相对 import 必然 ERR_MODULE_NOT_FOUND（第 191 波第一版实测把真机脚本弄崩，CLI-1 判据抓到）。所以脚本必须**自包含**：口径由 BYTES-3 的行为断言与共享实现逐字对齐",
  },
  {
    file: "src/core/skills/skill-creator/scripts/package-skill.ts",
    reason: "同上（同一个技能脚本目录、同一份自包含要求）",
  },
];

/** 去掉注释（块注释 + 行注释再剥离）——注释里提到 `/1024` 不算实现 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * **判定谓词**（纯函数，`BYTES-1` 与 `BYTES-1b` 共用同一处口径）。
 *
 * 命中条件：**字节换算**之后（40 个字符以内）出现**字节单位词**。三种换算形态都覆盖：
 * - `/ 1024`（KiB 进制）、`/ 1048576`、`/ (1024 * 1024)`；
 * - `/ 1_000_000`（**十进制 MB** —— 本仓真出现过，见 `quick-validate.ts` 的历史形态）；
 * - `.toFixed(n)}MB` 这种"先定小数位再拼单位"的形态。
 *
 * 刻意**不**命中的形态（否则判据会变成噪音，等于没有）：
 * - 只做字节**上限**常量（`256 * 1024 * 1024`，乘不是除）；
 * - token 数量的 `M` 后缀（`${(tokens / 1000000).toFixed(1)}M` —— 单位是 `M` 不是 `MB`）；
 * - 时长换算（`/ 3_600_000`）；
 * - `formatBytes(...)` / `megabytesOf(...)` 的调用（那是"用唯一实现"）。
 */
function looksLikeByteFormatter(code: string): boolean {
  const hasUnit = /\b(KiB|MiB|GiB|KB|MB|GB)\b/.test(code);
  if (!hasUnit) return false;
  const divides =
    /\/\s*\(?\s*(?:1024|1048576|1_000_000|1000000)\b/.test(code) ||
    /\/\s*\(\s*1024\s*\*\s*1024\s*\)/.test(code);
  /*
   * "先算数字、稍后再拼单位"的**分裂形态**（真出现过：`const sizeKB = (x / 1024).toFixed(1)` 在
   * 上一行、`(${sizeKB} KB)` 在下一行）—— 靠"同一文件里同时有除法与单位词"覆盖，
   * 所以这里的分母例外只判"有没有那种除法"，不要求同一行。
   */
  const fixedThenUnit = /\.toFixed\(\s*\d\s*\)[^;\n]{0,12}?\b(KiB|MiB|GiB|KB|MB|GB)\b/.test(code);
  return divides || fixedThenUnit;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "test" && path.basename(dir) === "src") continue; // 夹具不算产品口径
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(path.relative(ROOT, abs).replace(/\\/g, "/"));
    }
  }
  return out;
}

const ALL_FILES = walk(path.join(ROOT, "src"));

/** 命中"字节换算 + 字节单位词"的文件（注释已剥离） */
function byteFormatterFiles(): string[] {
  const hits: string[] = [];
  for (const rel of ALL_FILES) {
    if (rel === SINGLE_SOURCE) continue;
    const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
    if (looksLikeByteFormatter(code)) hits.push(rel);
  }
  return hits.sort();
}

describe("BYTES-SINGLE-SOURCE：字节数的人读形态只许有一份实现", () => {
  it("BYTES-1b 防恒真: 判定谓词对历史形态必须判红、对合法用法必须判绿", () => {
    // ① 扫描面必须是真的（不是"扫了 0 个文件所以永远绿"）
    expect(ALL_FILES.length, "扫描面太窄 ⇒ 这条判据等于没扫").toBeGreaterThan(300);
    expect(ALL_FILES).toContain(SINGLE_SOURCE);

    // ② 8 处历史副本的**原文形态**逐条必须被判红
    const historical = [
      'if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;',
      'if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;',
      'return `${(n / 1024 / 1024).toFixed(2)}MB`;',
      '<span className="nb-source-size">{(source.size / 1024).toFixed(1)}KB</span>',
      'const sizeKB = (zipped.length / 1024).toFixed(1);\nconsole.log(`packaged (${sizeKB} KB)`);',
      'console.log(`Size: ${(result.info.totalSize / 1024).toFixed(1)}KB`);',
      '`${(dbSizeBytes / 1048576).toFixed(1)} MB`',
      '`Total skill size is ${(info.totalSize / 1_000_000).toFixed(1)}MB`',
    ];
    for (const snippet of historical) {
      expect(looksLikeByteFormatter(snippet), `历史形态必须被判红：${snippet.slice(0, 60)}`).toBe(true);
    }

    // ③ 合法用法不许被判红（否则判据会变成噪音，没人会看它）
    const legitimate = [
      'const INTEGRITY_CHECK_LARGE_DB_BYTES = 256 * 1024 * 1024; // 上限（乘不是除）',
      'const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;',
      'import { formatBytes } from "../utils/bytes";',
      'return `空间回收 已回收 ${formatBytes(outcome.reclaimedBytes)}`;',
      'const waitH = ((windowMs - (now - lastAt)) / 3_600_000).toFixed(1);',
      // token 的 `M` 后缀不是字节单位（成本/用量统计里到处是这一形态）
      'if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;',
      'return `${scaled(n / 1_000_000)}M`',
    ];
    for (const snippet of legitimate) {
      expect(looksLikeByteFormatter(snippet), `合法用法不许被判红：${snippet.slice(0, 60)}`).toBe(false);
    }
  });

  it("BYTES-1: 换算 + 单位词的文件只能是唯一实现或登记在例外表里（例外表不许过期）", () => {
    const hits = byteFormatterFiles();
    const registered = new Set(EXCEPTIONS.map((e) => e.file));

    const unexpected = hits.filter((f) => !registered.has(f));
    expect(
      unexpected,
      `这些文件自己算了一遍字节的人读形态（应改为 import { formatBytes } from "src/core/utils/bytes"）：\n  ${unexpected.join("\n  ")}`,
    ).toEqual([]);

    // 例外表不许过期：登记的每一条都必须**真的**仍然命中
    const stale = EXCEPTIONS.filter((e) => !hits.includes(e.file));
    expect(
      stale.map((s) => s.file),
      "例外表里有条目已经不再命中（代码变了）——删除它，或把新的真实情况写进去",
    ).toEqual([]);
    for (const e of EXCEPTIONS) expect(e.reason.length, `${e.file} 的例外理由太短`).toBeGreaterThan(10);

    // 七个消费方必须走唯一实现（改回本地实现 ⇒ BYTES-1 会红）
    const mustUseShared = [
      "src/components/InputArea.tsx",
      "src/components/MessageBubble.tsx",
      "src/core/storage/maintenance.ts",
      "src/components/NotebookWorkspace.tsx",
      "src/core/diagnostics/renderer-evidence.ts",
    ];
    for (const rel of mustUseShared) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src.includes("formatBytes") || src.includes("megabytesOf"), `${rel} 必须使用共享实现`).toBe(true);
      expect(
        /function formatBytes|function formatSize|const sizeKB/.test(src),
        `${rel} 不许再有本地的字节格式化实现`,
      ).toBe(false);
    }
    // 两个技能脚本**例外**（自包含，见例外表）：它们必须**有**自己的实现，且不许 import 应用模块
    for (const rel of EXCEPTIONS.map((e) => e.file)) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(/function formatBytes/.test(src), `${rel} 必须自带 formatBytes（自包含）`).toBe(true);
      expect(
        // 只看 **import 语句**（注释里会提到那个路径来解释为什么不 import）
        /^\s*import[^;]*utils\/bytes/m.test(src),
        `${rel} 不许 import 应用内的 bytes 模块 —— 它会被复制进技能目录，那里没有源码树（真机实测会 ERR_MODULE_NOT_FOUND）`,
      ).toBe(false);
    }
  });

  it("BYTES-3: 例外（技能脚本的自包含实现）必须与共享实现**逐字一致**", async () => {
    /*
     * 这两个脚本不能 import 应用模块（它们会被复制进技能目录，见例外表的理由），
     * 所以"同一规则只许一处实现"在这里退一步：**允许多一份，但不许有第二套口径**。
     * 判据用行为断言钉住 —— 同一批输入必须给出同一个字符串（含边界与非法输入）。
     */
    const { formatBytes: scriptFormatBytes } = await import(
      "../core/skills/skill-creator/scripts/quick-validate.ts"
    );
    const inputs = [0, -1, Number.NaN, 1, 512, 1023, 1024, 2048, 1_572_864, 5 * 1024 * 1024, 2 * 1024 * 1024 * 1024];
    for (const n of inputs) {
      expect(scriptFormatBytes(n), `例外实现与共享实现在 ${n} 上分叉了（那就成了第二套口径）`).toBe(formatBytes(n));
    }
  });

  it("BYTES-2: 唯一实现的口径被钉住，且插件的再导出就是同一份实现", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    // MB 数字那一种形状同源（舍入方向只有一处定义）
    expect(megabytesOf(5 * 1024 * 1024)).toBe(5);
    expect(megabytesOf(1_572_864)).toBe(1.5);
    expect(megabytesOf(-1)).toBe(0);
    // 再导出必须是**同一个函数**（不是各写一份看起来一样的）
    expect(formatBytesFromPlugin).toBe(formatBytes);
  });
});
