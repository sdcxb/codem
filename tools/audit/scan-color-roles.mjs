/**
 * **颜色用量注册表审计**（第 161 轮，对标 OpenBitFun 的 color-governance baseline；audit 第 20 道）。
 *
 * ## 它解决什么（真实缺口，不是"为了体系完整"）
 *
 * 第 157 轮我是**手工**数出来的：全项目 57 处"状态色文字压在同色浅底上"，其中浅色档 error 在 20% 浅底上
 * 只有 **3.87:1**（10–12px 小标签），info 4.04、warning 4.37 —— 全部低于 4.5。
 * 那次是"人肉扫 + 写个一次性脚本"，也就是说：**同一类问题下次还会漏**。
 * 这道门禁把它变成机器判据：
 *   ① 扫描所有"同一条规则里既有文字色、又有底色"的声明；
 *   ② 文字色与底色都必须是**注册表里登记过的角色/表面**（未登记的配对直接红）；
 *   ③ 登记过的配对还要**实算对比度**（按两档主题各自解析令牌，含 `var()`/`color-mix()`），
 *      低于角色floor 就红 —— 这一条正是 157 轮那个 3.87 会被自动抓到的地方；
 *   ④ 解析不了的（渐变底、字面色、非令牌）记进 `unresolved` 并**只许降**（棘轮），
 *      避免"扫不到就等于没问题"这种自欺。
 *
 * 对标的做法是 budget + allowlist（每个类别 max 0）；我们保留同样的语义，
 * 但把"可算的那部分"从 allowlist 变成**实算对比度**，因为算得出来的东西不该靠名单。
 *
 * 用法：
 *   node tools/audit/scan-color-roles.mjs            # 打印读数
 *   node tools/audit/scan-color-roles.mjs --check    # 闸门
 *   node tools/audit/scan-color-roles.mjs --write    # 重建注册表（只许收不许放，除非 --force）
 *   node tools/audit/scan-color-roles.mjs --json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : path.join(HERE, "..", ".."));
const REGISTRY = path.join(HERE, "color-roles.json");

export const DEFAULT_FILES = [
  "src/styles.css",
  "src/styles/codem-ui.css",
  "src/styles/notebook-workspace.css",
  "src/styles/task-center.css",
];

/**
 * 文字角色 → 对比度下限。
 *
 * 口径（每条都有出处，不是拍的）：
 *   · `--text-primary/secondary/muted`：WCAG AAA 7 / 6 / AA 4.5
 *     （注：`--text-primary` 在**内容面**上还有一条更严的项目内门禁 ≥10，见 DARK-UI-3；
 *      这里取 7 是因为注册表要覆盖**悬停面/内嵌块**这类更亮的底，拿 10 去卡会产生假红。）
 *   · `--text-on-accent`：**3**（AA-large）—— 这是**有意放宽并登记的偏差**：暗色档白字压紫底实测 **3.99**
 *     （对标文档 D5 也量到同一条），要过 4.5 只有两条路：把紫调深、或改用深色字 —— 两者都会明显
 *     改变暗色观感，属产品决策（已写进对标文档"D 系列待办"，不靠门禁偷偷放过）。
 *   · `--text-on-status`：4.5 —— 白字压在暗色的 success/warning/info/error 上只有 2.5–2.8，
 *     所以这一档在暗色改成**深色墨水**（实测四色 5.5–8.3 全过）。
 */
export const ROLE_FLOORS = {
  "--text-primary": 7,
  "--text-secondary": 6,
  "--text-muted": 4.5,
  "--text-on-accent": 3,
  "--text-on-status": 4.5,
  "--accent": 4.5,
  "--accent-strong": 4.5,
  "--success": 4.5,
  "--warning": 4.5,
  "--error": 4.5,
  "--info": 4.5,
  "--success-content": 4.5,
  "--warning-content": 4.5,
  "--error-content": 4.5,
  "--info-content": 4.5,
};

const isRole = (name) => Object.prototype.hasOwnProperty.call(ROLE_FLOORS, name);

/* ---------------- 颜色解析（hex / rgb(a) / var() / color-mix / transparent） ---------------- */
const parsePlain = (s) => {
  const str = String(s).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(str);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(str);
  if (hex3) {
    const [r, g, b] = hex3[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?\s*\)/i.exec(str);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] === "%" ? 100 : 1);
  return { r: +m[1], g: +m[2], b: +m[3], a };
};

/** 解析一个颜色表达式；解析不了返回 null（**不猜**） */
export const resolveColor = (value, vars, depth = 0) => {
  if (depth > 8) return null;
  const v = String(value ?? "").trim();
  if (!v) return null;
  const alias = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
  if (alias) {
    const found = vars?.[alias[1]];
    if (found !== undefined) return resolveColor(found, vars, depth + 1);
    return alias[2] !== undefined ? resolveColor(alias[2], vars, depth + 1) : null;
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\)$/i.exec(v);
  if (mix) {
    const a = resolveColor(mix[1], vars, depth + 1);
    const b = resolveColor(mix[3], vars, depth + 1);
    if (!a || !b) return null;
    const w = Number(mix[2]) / 100;
    /* ⚠️ 与浏览器一致：**先 premultiply 再除以 alpha 还原**。
       第一版漏了这一步，于是 `color-mix(in srgb, var(--error) 20%, transparent)` 被读成 rgb(41,7,9)
       而不是 rgb(207,34,46)（alpha 0.2）—— 半透明表面的对比度全算错（CR-3 因此报了 4.13 而不是 4.65）。
       这个坑在本仓库出现过两次（_text-ramp-delta.mjs / 测试助手），这次是第三次：凡是要算颜色，
       半透明就必须走"预乘 → 还原"。 */
    const alpha = a.a * w + b.a * (1 - w);
    const denom = alpha || 1;
    return {
      r: (a.r * a.a * w + b.r * b.a * (1 - w)) / denom,
      g: (a.g * a.a * w + b.g * b.a * (1 - w)) / denom,
      b: (a.b * a.a * w + b.b * b.a * (1 - w)) / denom,
      a: alpha,
    };
  }
  if (/^transparent$/i.test(v)) return { r: 0, g: 0, b: 0, a: 0 };
  return parsePlain(v);
};

export const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});
export const luminance = ({ r, g, b }) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/* ---------------- 抽取令牌表与规则 ---------------- */

/**
 * 去注释但**保持偏移不变**（把注释里的非换行字符换成空格）。
 *
 * 为什么不用 `replace(comment, "")`：那样后面所有偏移都会前移，报出来的**行号是错的** ——
 * 第一版就是这样，报告里 `src/styles.css:11265 .quote-context-banner` 实际指向一个 `@keyframes`。
 * 门禁报的位置不能用，等于让人拿着假线索去改代码。
 */
const stripCommentsKeepOffsets = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

export const collectVars = (css) => {
  const clean = stripCommentsKeepOffsets(css);
  /**
   * 选择器按**空白分词**再拼成用 `\s*` 连接的正则。
   * ⚠️ 第一版直接把选择器整串转义后拼进正则，于是 `:root, [data-theme="light"]` 里那个**空格**
   * 变成了"必须恰好一个空格"，而文件里是**换行**（`:root,\n[data-theme="light"] {`）
   * ⇒ 亮色档一个令牌都取不到，整道门禁只在**暗色**档上跑、还报"全部通过"。
   * 这类"口径静默漏一半"必须由门禁自己暴露：`mutate-color-role-gates.mjs` 的 C5 钉住它。
   */
  const selectorBlock = (sel) => {
    const pattern = sel
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    const re = new RegExp(`^\\s*${pattern}\\s*\\{`, "m");
    const m = re.exec(clean);
    return m ? clean.slice(m.index + m[0].length, clean.indexOf("\n}", m.index)) : "";
  };
  const varsOf = (block) => {
    const out = {};
    for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  /** 找**所有**匹配这个选择器的块并合并（后写覆盖先写）—— 文件里有好几个 `:root`（基础档、各表自己的令牌块） */
  const allBlocks = (sel) => {
    const pattern = sel
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    const re = new RegExp(`^\\s*${pattern}\\s*\\{`, "gm");
    const out = {};
    let m;
    while ((m = re.exec(clean))) {
      const end = clean.indexOf("\n}", m.index);
      Object.assign(out, varsOf(clean.slice(m.index + m[0].length, end)));
    }
    return out;
  };
  /**
   * 层叠模型：`基础 :root`（含各样式表自己的令牌块）→ 主题档覆盖。
   * ⚠️ 只读主题块是不够的：像 `--surface-hover` / `--surface-1` / `--rich-code-bg` 这类令牌
   * 定义在 `codem-ui.css` 的 `:root` 里，只读 styles.css 的主题块会把它们判成"缺令牌"，
   * 于是严格口径下会冒出 56 条**假违规**（第 161 轮实测）。
   */
  const base = allBlocks(":root");
  return {
    /* 亮色档的写法在文件里**有两种**（`:root,\\n[data-theme="light"] {` 与 `[data-theme="light"] {`）——
       只认其中一种会让另一个样式表里的亮色令牌漏掉，于是拿基础档（多半是暗色值）去算，
       冒出"亮色档 2.79:1"这种假违规（第 161 轮实测：56 条假违规里大部分是这一类）。 */
    light: { ...base, ...allBlocks('[data-theme="light"]'), ...allBlocks(':root, [data-theme="light"]') },
    dark: { ...base, ...allBlocks('[data-theme="dark"]') },
  };
};

/** 扫出一条规则里的"文字色 × 底色"配对 */
export const scanPairs = (css, file) => {
  const clean = stripCommentsKeepOffsets(css);
  const pairs = [];
  const unresolved = [];
  const re = /([^{}\n]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const body = m[2];
    const line = clean.slice(0, m.index).split("\n").length;
    const colorDecl = /(?:^|[\s;])color:\s*([^;]+);/.exec(body);
    const bgDecl = /(?:^|[\s;])background(?:-color)?:\s*([^;]+);/.exec(body);
    if (!colorDecl) continue;
    const fgRaw = colorDecl[1].trim();
    const fgVar = /^var\((--[\w-]+)\)$/.exec(fgRaw)?.[1] ?? null;
    /* 文字色不是"注册的角色"就**与本门禁无关**（字面色、渐变文字、非角色的令牌……）——
       直接跳过，不要记进 unresolved：unresolved 的语义是"这一对属于本门禁、但暂时算不出来"，
       把无关规则也算进去，预算数字就失去意义了（CR-5 钉的就是这条）。 */
    if (!fgVar || !isRole(fgVar)) continue;
    if (!bgDecl) continue;
    const bgRaw = bgDecl[1].trim();
    const bgVar = /^var\((--[\w-]+)\)$/.exec(bgRaw)?.[1] ?? null;
    if (!bgVar) {
      /* 文字是注册角色、底色却是渐变色/字面量/多层 —— 记进 unresolved（只许降），不要假装扫过了 */
      unresolved.push({ file, line, selector, fg: fgVar, bg: bgRaw.slice(0, 48), why: "底色不是单个令牌（渐变/字面量/多层）" });
      continue;
    }
    /* 遮罩/背景层：底色取决于它**盖住的内容**（模态背后可能是任意界面），不能按固定底色算对比度。
       实测（第 161 轮）：`--text-on-accent` 压在 `--overlay-backdrop` 上按"压在内容面"算只有 2.00，
       但真实情况是白字压在半透明黑遮罩上 —— 那是**算不出来的**，记进预算比报假红诚实。 */
    if (/overlay|backdrop|scrim/i.test(bgVar)) {
      unresolved.push({ file, line, selector, fg: fgVar, bg: bgVar, why: "遮罩/背景层：底色取决于盖住的内容，算不出固定对比度" });
      continue;
    }
    pairs.push({ file, line, selector, role: fgVar, surface: bgVar });
  }
  return { pairs, unresolved };
};

/* ---------------- 主流程 ---------------- */
export function scanColorRoles({ files, vars, registry }) {
  const allPairs = new Map(); // "role|surface" → { count, samples[] }
  const unresolved = [];
  for (const f of files) {
    const { pairs, unresolved: u } = scanPairs(f.css, f.path);
    unresolved.push(...u);
    for (const p of pairs) {
      const key = `${p.role}|${p.surface}`;
      const cur = allPairs.get(key) ?? { count: 0, samples: [] };
      cur.count++;
      if (cur.samples.length < 3) cur.samples.push(`${p.file}:${p.line} ${p.selector.slice(0, 48)}`);
      allPairs.set(key, cur);
    }
  }

  const registered = registry?.pairs ?? {};
  const violations = [];
  const findings = [];

  for (const [key, info] of allPairs) {
    const [role, surface] = key.split("|");
    if (!registered[key]) {
      violations.push({ kind: "unregistered", key, count: info.count, samples: info.samples, why: `${role} 压在 ${surface} 上是**未登记**的组合` });
      continue;
    }
    /* 实算两档主题的对比度（解析不了就记 unresolved，不要静默跳过）
       ⚠️ 这里必须传 `var(--x)` 而不是裸的 `--x`：解析器认的是**声明里的表达式**（`var()`/`color-mix()`），
       裸令牌名它只会当成无法解析的字符串 —— 第一版就是这么写的，于是 54 对全部报"解析不了"。
       ⚠️ 而且：**登记过的配对**解析不出来（多半是"某个档里根本没定义这个令牌"）算**违规**、不记 unresolved。
       第 161 轮 `--text-on-status` 只定义在亮色档，暗色档的状态色块仍是白字（2.54:1），
       却因为"解析不了"被记进预算、门禁照绿 —— 这是口径漏洞，已收紧：
       unresolved 只装"本来就算不出来"的（渐变底、遮罩层），不装"我们自己的令牌缺了"。 */
    for (const theme of ["light", "dark"]) {
      const v = vars[theme] ?? {};
      const fg = resolveColor(`var(${role})`, v);
      const bgBase = resolveColor(`var(${surface})`, v);
      if (!fg || !bgBase) {
        violations.push({
          kind: "unresolved-token",
          key,
          count: info.count,
          samples: info.samples,
          why: `${theme} 档解析不了（缺令牌或不支持的写法）：${[!fg && role, !bgBase && surface].filter(Boolean).join(" / ")}`,
        });
        continue;
      }
      const bg = over(bgBase, resolveColor("var(--bg-primary)", v) ?? bgBase);
      const ratio = contrast(over(fg, bg), bg);
      const floor = ROLE_FLOORS[role];
      findings.push({ key, theme, ratio, floor });
      if (ratio + 1e-9 < floor) {
        violations.push({
          kind: "below-floor",
          key,
          count: info.count,
          samples: info.samples,
          why: `${theme} 档 ${role} 压在 ${surface} 上只有 ${ratio.toFixed(2)}:1（下限 ${floor}）`,
        });
      }
    }
  }

  return {
    pairs: allPairs,
    findings,
    violations,
    unresolved,
    /** 去重后的 unresolved 键（预算按它算 —— 同一形态出现 100 次只算 1 条） */
    unresolvedKeys: [...new Set(unresolved.map((u) => `${u.fg}|${u.bg}|${u.why}`))].sort(),
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const files = DEFAULT_FILES.filter((rel) => fs.existsSync(path.join(ROOT, rel))).map((rel) => ({ path: rel, css: fs.readFileSync(path.join(ROOT, rel), "utf8") }));
  const vars = collectVars(files.map((f) => f.css).join("\n"));
  const registry = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, "utf8")) : { pairs: {} };
  const { pairs, findings, violations, unresolved } = scanColorRoles({ files, vars, registry });

  /* unresolved 去重（同一 (selector, why) 只留一条） */
  const unresolvedKeys = [...new Set(unresolved.map((u) => `${u.fg}|${u.bg}|${u.why}`))].sort();
  const budget = registry.unresolvedBudget ?? 0;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ pairs: pairs.size, violations, findings, unresolvedKeys }, null, 1));
    process.exit(violations.length > 0 || unresolvedKeys.length > budget ? 1 : 0);
  }

  console.log(`颜色用量注册表：扫了 ${files.length} 个文件、"文字角色 × 表面"配对 ${pairs.size} 种`);
  const worst = findings.sort((a, b) => a.ratio - b.ratio).slice(0, 6);
  console.log("最紧的几对（实算）：");
  for (const f of worst) console.log(`  ${f.theme.padEnd(5)} ${f.ratio.toFixed(2)}:1  下限 ${String(f.floor).padStart(4)}   ${f.key}`);

  if (process.argv.includes("--write")) {
    const nextPairs = {};
    for (const key of [...pairs.keys()].sort()) nextPairs[key] = registry.pairs?.[key] ?? { registeredAt: new Date().toISOString().slice(0, 10) };
    const dropped = Object.keys(registry.pairs ?? {}).filter((k) => !pairs.has(k));
    if (dropped.length > 0 && !process.argv.includes("--force")) {
      console.error(`\n❌ 这些登记项在当前代码里已经不存在了：${dropped.join(", ")}\n   （要让注册表变小请显式加 --force：注册表是棘轮，删条目也要有意识。）`);
      process.exit(1);
    }
    /* ⚠️ 预算必须**在登记之后**再算一遍：登记前那些配对走的是 "unregistered" 分支、根本不解析颜色，
       所以第一次写出来的预算（59）比真实值（167）小 —— 下一次 --check 立刻自己红。
       这是"写基线的人必须先把口径跑对"的实例：变异会自己抓出来，但更该在写之前想清楚。 */
    const second = scanColorRoles({ files, vars, registry: { pairs: nextPairs } });
    const finalUnresolved = [...new Set(second.unresolved.map((u) => `${u.fg}|${u.bg}|${u.why}`))].sort();
    fs.writeFileSync(
      REGISTRY,
      JSON.stringify(
        {
          _note: "颜色用量注册表（第 161 轮，audit 第 20 道）。键是 `角色|表面`；未登记的配对会被 --check 拦下。unresolvedBudget 只许降。",
          _measuredAt: new Date().toISOString(),
          unresolvedBudget: finalUnresolved.length,
          pairs: nextPairs,
          unresolved: finalUnresolved,
        },
        null,
        1,
      ) + "\n",
      "utf8",
    );
    console.log(`\n已写注册表：${Object.keys(nextPairs).length} 对、unresolved ${finalUnresolved.length}（登记后再算过一遍）`);
    process.exit(0);
  }

  if (violations.length > 0) {
    console.error("\n🔴 颜色用量违规：");
    for (const v of violations) console.error(`  [${v.kind}] ${v.key}  ×${v.count}  ${v.why}\n      例：${v.samples.join(" | ")}`);
  }
  if (unresolvedKeys.length > budget) {
    console.error(`\n🔴 解析不了的配对涨了：${budget} → ${unresolvedKeys.length}`);
    for (const u of unresolvedKeys.slice(0, 6)) console.error(`  ${u}`);
  }
  const ok = violations.length === 0 && unresolvedKeys.length <= budget;
  console.log(
    ok
      ? `✅ 颜色用量注册表通过：${pairs.size} 对全部已登记且过对比度下限；未解析 ${unresolvedKeys.length}（预算 ${budget}）`
      : `❌ 违规 ${violations.length} 项、未解析超预算 ${Math.max(0, unresolvedKeys.length - budget)} 项`,
  );
  if (process.argv.includes("--check") && !ok) process.exit(1);
  process.exit(0);
}
