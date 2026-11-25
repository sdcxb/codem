/** unslop 收口：图标尺寸只允许 16/20；24 仅限插画/头像/空态，32+ 为插画。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const roots = ["src/components", "src/plugins", "packages/ui/src"];
const files: string[] = [];
for (const root of roots) {
  const base = path.join(ROOT, root);
  if (!fs.existsSync(base)) continue;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) files.push(full);
    }
  };
  walk(base);
}

/** 24px 仅用于明确的插画/头像/空态所有者；新增必须在这里登记理由。 */
const ALLOW_24 = new Map([
  ["src/components/ppt/PPTAdapter.tsx", "PPT 舞台主图标"],
  ["src/components/PetMarketDialog.tsx", "宠物市场空态图标"],
  ["src/components/SettingsPanel.tsx", "身份头像占位"],
  ["src/plugins/library-ops/components/library/PixelLibraryScene.tsx", "像素场景拖放插画"],
]);

describe("UI 图标尺寸刻度", () => {
  it("不存在 10/12/14/18 的图标字面尺寸", () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/size=\{(10|12|14|18)\}/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(`${path.relative(ROOT, file)}:${line} size={${m[1]}}`);
      }
    }
    expect(hits, "图标只允许 16/20；小的状态图标也要 16").toEqual([]);
  });

  it("24px 只出现在登记过的插画/头像/空态文件", () => {
    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      if (ALLOW_24.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/size=\{24\}/.test(text)) hits.push(rel);
    }
    expect(hits, "24px 图标若用于控件，请改为 20 或登记为插画").toEqual([]);
  });

  it("16 是默认档，20 存在为大图标档", () => {
    let s16 = 0;
    let s20 = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      s16 += (text.match(/size=\{16\}/g) ?? []).length;
      s20 += (text.match(/size=\{20\}/g) ?? []).length;
    }
    expect(s16).toBeGreaterThan(500);
    expect(s20).toBeGreaterThan(0);
  });
});
