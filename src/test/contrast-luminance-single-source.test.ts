/**
 * CR-CONTRAST-1 —— 相对亮度的线性化阈值在全仓**只许有一处实现**（GAP-LIST O-39，第 191 波）。
 *
 * ## 它守的是什么（不是「为了体系完整」）
 *
 * O-39 的原始形态：`src/core/theme/contrast-checker.ts` 用 WCAG 2.1 **勘误后**的阈值，
 * 而 `tools/audit/scan-color-roles.mjs` 与三个测试文件各自镜像了一份 **WCAG 2.0 初版/1.0 的旧值**
 * ⇒ **同一事实 4 处实现**；「为什么不合并」只写在给上级的报告里，仓库里一个字都没有。
 * 这正是本仓反复吃亏的形态（第 189 波教训 1「同一簇 bug 会成三份出现」），
 * 而「同一规则只许一处实现」在本仓是有纪律的 —— 没有判据的收敛，下一轮必然有人再问一次「哪个对」。
 *
 * ## 收敛后的形态（谁读谁）
 *
 * | 运行面 | 文件 | 读法 |
 * | --- | --- | --- |
 * | 产品（Vite 打包 TS） | `src/core/theme/contrast-checker.ts` | `import { srgbLinearThreshold } from "./wcag-luminance.json"` |
 * | 审计（纯 node，不打包） | `tools/audit/scan-color-roles.mjs` | `readFileSync` + `JSON.parse` **同一个** JSON |
 * | 三个既有判据 | `css-integrity` / `light-theme-contrast` / `style-token-gates` | `import { channelLinear }`（不再各自镜像阈值） |
 * | 唯一数值来源 | `src/core/theme/wcag-luminance.json` | `srgbLinearThreshold` |
 *
 * 漂移量化（53 对 × 2 档 = 106 条读数零漂移、0 条翻转、基数无翻转）记在
 * `tools/audit/color-roles-threshold-drift.md`。
 *
 * ## 判据与反向对照（「每一条都要有反向对照」，逐条列在这里）
 *
 * | # | 判据 | 反向对照（证明它不是恒真） |
 * | --- | --- | --- |
 * | CR-1 | 解析式对账：`src/**` + `tools/**` 的**代码**里，两个阈值字面量只许出现在唯一来源文件；例外表逐条命中且命中数不许涨 | CR-1c 喂一个含旧值的假文件 ⇒ 必须被扫出来；CR-1d 同一段放进注释 ⇒ 必须不报，而**混排**（注释+真代码）⇒ 必须报出代码那一处 |
 * | CR-2 | 产品侧与审计侧读的是**同一个来源**：同一个探针通道下两条路径给出同一个线性值、同一个对比度 | CR-2b 先断言探针**能区分**两个阈值（否则 CR-2a 等于没测）；CR-2c 换成旧阈值时对比度必须变 |
 * | CR-3 | 唯一来源里的数**必须是勘误后的那个**（口径不许被改回去），且说明文字里写下了「为什么」 | CR-3 断言它**不**等于旧值，并断言这两个数确实不同 |
 *
 * ## 为什么本文件里看不到那两个阈值数字
 *
 * 本判据就是**扫描它们**的：把字面量写进来会自指（判据把自己判成违规）。
 * 所以针一律用拼接构造（形如 `["0.039", "28"].join("")`）—— 这不是绕过判据，
 * 而是让「判据自身」不进入「被扫的实现」这个集合。
 *
 * ## 扫描口径（刻意的两条边界）
 *
 * 1. **只扫代码**扩展名（`.ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.json/.css/.html`）⇒ `.md` 散文
 *    （`docs/GAP-LIST.md`、`tools/audit/color-roles-threshold-drift.md`）必须能**自由讨论**这两个数值。
 *    判据守的是「实现只有一处」，不是「字面上不许提」。
 * 2. **先剥注释**（字符串字面量保留）⇒ 文件头注释可以、也应该把口径写清楚。
 *    `CR-3b` 反过来要求那段注释**必须存在**（结论过期/被删就红），
 *    于是「讲道理的注释」既不被判成实现、也不能悄悄消失。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { channelLinear, contrastOfRgba, resolveRgba } from "../core/theme/contrast-checker";
import {
  luminance as auditLuminance,
  contrast as auditContrast,
  srgbLinearThreshold as auditThreshold,
} from "../../tools/audit/scan-color-roles.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * ⚠️ 拼接构造（见文件头）：判据自己不许出现阈值字面量。
 * `CORRECT` = WCAG 2.1 勘误后的值；`STALE` = WCAG 2.0 初版/1.0 的旧值。
 */
const CORRECT = ["0.040", "45"].join("");
const STALE = ["0.039", "28"].join("");
const NEEDLES = [CORRECT, STALE];
const STALE_NUMBER = Number(STALE);

const WCAG_JSON_REL = "src/core/theme/wcag-luminance.json";
const DRIFT_DOC_REL = "tools/audit/color-roles-threshold-drift.md";
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

/* ============================ 扫描器（CR-1 用） ============================ */

const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".css", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "coverage"]);
const JS_LIKE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/** 扫 `src/**` 与 `tools/**` 的代码文件路径（相对仓库根、统一用 `/`） */
function collectCodePaths(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(abs, e.name));
        continue;
      }
      if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push(path.relative(ROOT, path.join(abs, e.name)).replace(/\\/g, "/"));
    }
  };
  for (const dir of ["src", "tools"]) walk(path.join(ROOT, dir));
  return out.sort();
}

/**
 * 剥注释，**保留字符串字面量与换行**（换行要留，行号才准）。
 *
 * 为什么必须剥：口径结论就写在 `contrast-checker.ts` 的文件头注释里（O-39 第①步的强制要求），
 * 不剥的话判据会把自己的文档判成违规。JS/TS 家族处理行注释 `//` 与块注释；
 * 其它（CSS/JSON/HTML）只处理块注释 —— JSON 本身没有注释，等于原样。
 *
 * ⚠️ 剥注释**不能吞掉真代码**（否则判据会静默漏掉实现）。CR-1d 用「注释 + 同行真代码」的混排夹具
 * 钉住这一点；下面这个状态机也刻意跳过字符串内部（`"http://…"` 里的 `//` 不是注释）。
 */
function stripComments(src: string, jsLike: boolean): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (jsLike && c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (jsLike && (c === '"' || c === "'" || c === "`")) {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Hit {
  file: string;
  value: string;
  line: number;
  text: string;
}

/** 在给定文件集里找阈值字面量（先剥注释），返回逐处命中 */
function scanLiterals(files: Array<{ file: string; text: string }>, needles: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    const { file, text } = f;
    const jsLike = JS_LIKE.has(path.extname(file).toLowerCase());
    const code = jsLike || file.endsWith(".css") ? stripComments(text, jsLike) : text;
    const lines = code.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      for (const needle of needles) {
        let from = 0;
        for (;;) {
          const at = lines[li].indexOf(needle, from);
          if (at < 0) break;
          hits.push({ file, value: needle, line: li + 1, text: lines[li].trim().slice(0, 110) });
          from = at + needle.length;
        }
      }
    }
  }
  return hits;
}

/**
 * 例外表：字面量被允许出现在**代码**里的文件（逐条写理由、命中数被钉死）。
 *
 * 「不许过期」= 每条的 `expect` 必须**恰好**等于实际命中数：命中数掉了（文件被改/被删 ⇒ 条目过期）
 * 或者涨了（有人往里面加字面量 ⇒ 该重新论证）都判红。
 */
const ALLOWED_CODE: Array<{ file: string; expect: number; reason: string }> = [
  {
    file: WCAG_JSON_REL,
    expect: 7,
    reason:
      "**唯一数值来源**：`srgbLinearThreshold` 本身（1 处）+ note 里写明「哪个对、哪个是过时旧值、分歧窗口在哪」的说明（正确值 3 处、旧值 3 处）。全仓就这一个文件允许出现阈值字面量。",
  },
  {
    file: "tools/mutate/results/contrast-191.json",
    expect: 3,
    reason:
      "变异运行器**自动写出**的产物：它逐字记录「被改坏的原文」，而本波的变异就是把某一侧改回旧阈值（MUT-1/2/3 各 1 处）⇒ 快照里必然带旧值，否则无法复核。它不是实现、不参与打包，且不许手改（由 `tools/mutate/run.mjs` 生成）。",
  },
];

/* ============================ 参考算式（CR-2 的「解析式对账」） ============================ */

/**
 * 把「阈值」当**参数**的参考算式 —— 它本身不含任何阈值字面量，
 * 所以它是**对账用的预测式**，不是第 N 份实现。
 */
const linearize = (threshold: number, c: number): number => {
  const s = c / 255;
  return s <= threshold ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const refRatio = (threshold: number, a: number, b: number): number => {
  const [hi, lo] = [linearize(threshold, a), linearize(threshold, b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * 探针通道：**只有**落在两个阈值的分歧窗口里，才能证明「两边读的是同一个数」。
 * 窗口是 `s ∈ (旧值, 新值]` ⟺ 通道值 `∈ (10.0164, 10.31475]`（整数通道永远落不进去）。
 */
const PROBE_LO = 10.1;
const PROBE_HI = 10.2;
const inWindow = (c: number) => c / 255 > STALE_NUMBER && c / 255 <= Number(CORRECT);

describe("CR-CONTRAST-1 亮度阈值单一来源（GAP-LIST O-39，第 191 波）", () => {
  it("CR-1a：针的构造没坏（拼接出来的就是那两个 7 位小数，且互不相同）", () => {
    expect(CORRECT).toHaveLength(7);
    expect(STALE).toHaveLength(7);
    expect(CORRECT).not.toBe(STALE);
  });

  it("CR-1b：src/** 与 tools/** 的**代码**里，阈值字面量只许出现在唯一来源文件", () => {
    const paths = collectCodePaths();
    /* 防恒绿：扫描面窄了（遍历写坏）这条就变成"什么都没扫、所以干净" */
    expect(paths.length, "扫描面太窄说明遍历坏了（那这条就恒绿了）").toBeGreaterThan(1000);
    expect(paths.some((p) => p === WCAG_JSON_REL), "唯一来源文件必须在扫描面里").toBe(true);

    const hits: Hit[] = [];
    let strippingTouched = 0; // 有文件"原文里有、剥注释后没有" ⇒ 证明剥注释这条路径真的在跑
    for (const rel of paths) {
      const raw = readFileSync(path.join(ROOT, rel), "utf8");
      if (!NEEDLES.some((n) => raw.includes(n))) continue; // 便宜的前置过滤（剥注释只会让文字变少）
      const mine = scanLiterals([{ file: rel, text: raw }], NEEDLES);
      if (mine.length === 0) strippingTouched++;
      hits.push(...mine);
    }
    expect(
      strippingTouched,
      "没有任何文件出现「原文有、剥注释后没有」⇒ 剥注释这条路径没被真实数据走到（那它就没被验证过）",
    ).toBeGreaterThan(0);

    /* 例外表逐条对账：命中数必须**恰好**等于登记值（过期=掉了、失控=涨了） */
    for (const e of ALLOWED_CODE) {
      if (!existsSync(path.join(ROOT, e.file))) {
        /* 变异产物在跑 `tools/mutate/run.mjs` 之前不存在 —— 「结果文件必须存在」由
           MUTATE-ARTIFACT-1 那道闸门负责（`tools/mutate/check-artifacts.mjs`），不在这里重复。
           但**唯一来源文件**不存在是硬伤（那全仓就没有来源了），照红。 */
        expect(e.file, "唯一来源文件不存在（那全仓就没有阈值来源了）").not.toBe(WCAG_JSON_REL);
        continue;
      }
      const got = hits.filter((h) => h.file === e.file).length;
      expect(got, `例外表与实际不符：${e.file} 登记 ${e.expect} 处、实际 ${got} 处。理由：${e.reason}`).toBe(e.expect);
    }

    const outside = hits
      .filter((h) => !ALLOWED_CODE.some((e) => e.file === h.file))
      .map((h) => `${h.file}:${h.line} 出现 ${h.value} —— ${h.text}`);
    expect(outside, "阈值字面量逃出了唯一来源（代码里多出了一份实现）").toEqual([]);
  });

  it("CR-1c（反向对照）：夹具里的旧值必须被扫出来 —— 扫描器不是恒绿的", () => {
    const fake = [
      { file: "src/core/theme/fake-threshold.ts", text: `export const f = (s: number) => (s <= ${STALE} ? s / 12.92 : 1);` },
    ];
    const hits = scanLiterals(fake, NEEDLES);
    expect(hits, "假文件里的旧值必须被扫出来（否则 CR-1b 恒绿）").toHaveLength(1);
    expect(hits[0].file).toBe("src/core/theme/fake-threshold.ts");
    expect(hits[0].value).toBe(STALE);
    expect(hits[0].line).toBe(1);
  });

  it("CR-1d（反向对照）：注释里的说法不算实现，但注释**旁边**的真代码必须照报", () => {
    const commentOnly = [{ file: "src/core/theme/fake-comment.ts", text: `/** 旧值 ${STALE} 已经过时，这里只在讲道理 */\nexport const keep = 1;` }];
    expect(scanLiterals(commentOnly, NEEDLES), "注释是文档，不是实现").toEqual([]);

    /* 混排：行注释里提一次 + 真代码里用一次 ⇒ 必须**只**报代码那一处（证明剥注释没把代码一起吞掉） */
    const mixed = [
      {
        file: "src/core/theme/fake-mixed.ts",
        text: `// 旧值 ${STALE}\nexport const f = (s: number) => (s <= ${STALE} ? s / 12.92 : 1);`,
      },
    ];
    const hits = scanLiterals(mixed, NEEDLES);
    expect(hits, "剥注释把真代码一起吞掉了（那 CR-1b 会静默漏报）").toHaveLength(1);
    expect(hits[0].line).toBe(2);

    /* 字符串里的 `//` 不是注释的开头（状态机必须认得出字符串） */
    const urlLike = [{ file: "src/core/theme/fake-url.mjs", text: `const u = "http://x";\nconst t = ${CORRECT};` }];
    expect(scanLiterals(urlLike, NEEDLES), "字符串里的 // 被当成注释 ⇒ 后面的代码被吞了").toHaveLength(1);
  });

  it("CR-2a：产品侧与审计侧读的是**同一个来源**（同一个阈值）", () => {
    const json = readJson(WCAG_JSON_REL);
    /* 审计侧（纯 node）读到的 === JSON 里的那个数 */
    expect(auditThreshold, "审计侧读到的阈值与唯一来源不一致").toBe(json.srgbLinearThreshold);
    /* 产品侧（打包 TS）在探针通道上必须与「用 JSON 阈值算出来的值」一致 */
    expect(inWindow(PROBE_LO) && inWindow(PROBE_HI), "探针不在阈值分歧窗口内").toBe(true);
    for (const c of [PROBE_LO, PROBE_HI]) {
      expect(channelLinear(c), `产品侧在通道 ${c} 上与唯一来源不一致`).toBeCloseTo(linearize(json.srgbLinearThreshold, c), 12);
    }
  });

  it("CR-2b（反向对照）：探针真的能区分两个阈值 —— 否则 CR-2a 等于没测", () => {
    const json = readJson(WCAG_JSON_REL);
    for (const c of [PROBE_LO, PROBE_HI]) {
      const gap = Math.abs(linearize(json.srgbLinearThreshold, c) - linearize(STALE_NUMBER, c));
      expect(gap, `通道 ${c} 区分不开两个阈值（探针无效）`).toBeGreaterThan(1e-9);
    }
  });

  it("CR-2c：两条路径算出的对比度一致（实算，不是只比阈值）", () => {
    const json = readJson(WCAG_JSON_REL);
    const product = contrastOfRgba(resolveRgba(`rgb(${PROBE_LO} ${PROBE_LO} ${PROBE_LO})`)!, resolveRgba(`rgb(${PROBE_HI} ${PROBE_HI} ${PROBE_HI})`)!);
    const audit = auditContrast({ r: PROBE_LO, g: PROBE_LO, b: PROBE_LO }, { r: PROBE_HI, g: PROBE_HI, b: PROBE_HI });
    expect(product, "产品侧的对比度算不出数（解析器不认这个探针？）").toBeGreaterThan(1);
    expect(product).toBeCloseTo(audit, 12);
    expect(product).toBeCloseTo(refRatio(json.srgbLinearThreshold, PROBE_LO, PROBE_HI), 12);
    /* 反向对照：换成旧阈值这个比值必须变 —— 说明钉的是阈值，不是恒等式 */
    const oldRatio = refRatio(STALE_NUMBER, PROBE_LO, PROBE_HI);
    expect(Math.abs(product - oldRatio), "旧阈值下这个比值也一样 ⇒ 探针无区分力").toBeGreaterThan(1e-9);
  });

  it("CR-2d：整数通道 0–255 上两条路径逐点一致（真实取值域上不打架）", () => {
    for (let c = 0; c <= 255; c++) {
      expect(auditLuminance({ r: c, g: c, b: c }), `通道 ${c}：审计侧与产品侧不一致`).toBeCloseTo(channelLinear(c), 12);
    }
  });

  it("CR-3：口径不许被改回旧值 —— 唯一来源里的数必须是勘误后的那个", () => {
    const json = readJson(WCAG_JSON_REL);
    expect(json.srgbLinearThreshold).toBe(Number(CORRECT));
    /* 反向对照：它就该**不**等于旧值，而且这两个数确实不同（否则 not.toBe 是句废话） */
    expect(Number(CORRECT)).not.toBe(STALE_NUMBER);
    expect(json.srgbLinearThreshold, "唯一来源被改回了过时的旧值").not.toBe(STALE_NUMBER);
    /* O-39 第①步的另一半：结论与理由必须进仓库（不能只留在报告里） */
    expect(json.note, "唯一来源的说明里必须写明哪个是对的").toContain(CORRECT);
    expect(json.note, "唯一来源的说明里必须点明哪个是过时旧值").toContain(STALE);
    expect(json.note.length, "说明太短，等于没写理由").toBeGreaterThan(100);
  });

  it("CR-3b：文件头注释必须同时写下两个值与漂移记录路径（结论过期就红）", () => {
    const src = readFileSync(path.join(ROOT, "src/core/theme/contrast-checker.ts"), "utf8");
    expect(src, "文件头必须写明勘误后的正确值").toContain(CORRECT);
    expect(src, "文件头必须点明旧值已过时").toContain(STALE);
    expect(src, "文件头必须给出漂移量化记录的路径（结论不能只在报告里）").toContain(DRIFT_DOC_REL);
    /* 反向对照：漂移记录必须真的存在，且里面写下了「两个阈值下的通过集合差集」这件事本身 */
    const doc = readFileSync(path.join(ROOT, DRIFT_DOC_REL), "utf8");
    expect(doc).toContain(CORRECT);
    expect(doc).toContain(STALE);
    expect(doc, "漂移记录必须写出翻转/差集的实测读数").toMatch(/翻转/);
  });
});
