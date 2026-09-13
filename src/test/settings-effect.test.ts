/**
 * 设置项「落地」契约（第 61 波）。
 *
 * `settings-keys-symmetry.test.ts` 只能证明"这个键有人读、也有人写"，证明不了
 * **读到的值真的被用上了**。第 61 波的真实事故恰好落在这一格：
 *   · `codem-display-mode` —— 设置页写了、启动路径也"看起来"该读，但实际**没有任何读取方**，
 *     于是设置项能改、重启后永远回到默认；
 *   · `codem-current-project-path` —— 有读取方，但**没有写入方**，读到的永远是空串，
 *     codegraph 的「索引检测」从来没生效过。
 *
 * 所以这里补三条**接线断言**（与 `theme-boot.test.ts` 的 THEME-BOOT-5 同一手法：
 * 不是测渲染结果，而是锁住"启动路径确实把值交给了 store / 确实换了数据源"）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanText, constsFrom, stripComments } from "./helpers/settings-key-scan";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 与应用侧同一口径的文件清单（跳过测试目录 —— 测试里的读不能算"应用会读"） */
function walkSrc(dir = join(ROOT, "src"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "target", ".git", "test", "__snapshots__", "helpers"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSrc(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 剥掉注释，避免"解释 bug 的注释"把断言自己绊倒 */
const stripComments = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, " ");

describe("设置项落地契约（第 61 波）", () => {
  it("SKEY-E1: 启动路径必须读回「对话显示模式」并应用（写入端在设置页）", () => {
    const app = stripComments(read("src/App.tsx"));

    // 读的键必须与设置页写的键一致
    const settingsPanel = stripComments(read("src/components/SettingsPanel.tsx"));
    expect(settingsPanel, "设置页应写入 codem-display-mode").toMatch(
      /setSettingJSON\(\s*["']codem-display-mode["']/,
    );

    // 启动路径必须真的读它……
    const readBlock = app.match(/const\s+savedDisplayMode\s*=\s*getSetting\(\s*["']codem-display-mode["']\s*\)/);
    expect(readBlock, "启动路径必须读回 codem-display-mode（否则设置项存了不生效）").toBeTruthy();

    // ……并且把读到的值交给 store（合法值才应用，垃圾值回落默认档）
    expect(app, "读到的值必须交给 setDisplayMode").toMatch(
      /savedDisplayMode\s*===\s*["']unified["'][\s\S]{0,120}setDisplayMode\(savedDisplayMode\)/,
    );

    // 必须在数据库就绪之后 —— 太早读只会拿到空值（这正是"看起来读了、其实没生效"的形状）
    const initAt = app.indexOf("await initDatabase()");
    const readAt = app.indexOf("getSetting(\"codem-display-mode\")");
    expect(initAt, "App.tsx 里应有 initDatabase() 调用").toBeGreaterThan(-1);
    expect(readAt, "读取点应位于 initDatabase() 之后").toBeGreaterThan(initAt);
  });

  it("SKEY-E2: codegraph 索引检测不得再读没有写入方的 codem-current-project-path", () => {
    const settingsPanel = stripComments(read("src/components/SettingsPanel.tsx"));
    expect(
      settingsPanel,
      "codem-current-project-path 全项目没有写入方（读到的永远是空串），必须改读项目 store",
    ).not.toMatch(/codem-current-project-path/);
    expect(settingsPanel, "索引检测应取当前项目路径").toMatch(
      /useProjectStore\.getState\(\)\.currentProject\?\.path/,
    );
  });

  it("SKEY-E3: 设置页能改的每个键，应用侧都必须有人读（用同一个检测器对账）", () => {
    // 复用 SKEY 的检测器，而不是再写一个更弱的正则 ——
    // 第一版 E3 自己写了 `getSetting\\(\\s*"key"`，于是把
    // `getSettingJSON<DynamicModelMap>("codem-dynamic-models", {})` 这类**带泛型的读**全漏掉，
    // 一次误报 5 个键。教训与第 61 波一致：**判定逻辑只能有一份**，复用它。
    const panel = stripComments(read("src/components/SettingsPanel.tsx"));
    const written = new Set<string>();
    for (const m of panel.matchAll(/(?:setSetting|setSettingJSON)\(\s*["'](codem-[\w-]+)["']/g)) written.add(m[1]);
    expect(written.size, "设置页应该写入多个设置键").toBeGreaterThanOrEqual(5);

    const files = walkSrc();
    const readKeys = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const hit of scanText(src, constsFrom(src), new Map())) if (!hit.isWrite) readKeys.add(hit.key);
    }

    const missing = [...written].filter((k) => !readKeys.has(k));
    expect(
      missing,
      `设置页能改、但全项目没有任何地方读回来的键（用户会看到"改了没用"）：\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
