/**
 * 导出「图书馆场景布局参考图」——给绘图大模型做 img2img / ControlNet 的底图。
 *
 * 生成一张 1920×1072 的半透明布局图：房间矩形 + 房间名 + 可行走路网 + 工作锚点。
 * 用它作为参考图，可以让模型生成**布局与原版一致**的新场景，
 * 从而**无需改动代码**即可替换 `public/library-ops/claw-library/scene-*.webp`。
 *
 * 用法：
 *   node scripts/export-library-ops-layout-guide.mjs
 * 产物：
 *   tools/library-ops/layout-guide.png       （1920×1072，透明底 + 布局标注）
 *   tools/library-ops/layout-guide-solid.png （1920×1072，白底，便于部分模型使用）
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "tools", "library-ops");

/** 与 src/plugins/library-ops/data/pixel-art.ts 保持一致的布局数据 */
const W = 1920;
const H = 1072;

const ROOMS = [
  { id: "gateway", label: "前台 / 调度台", bounds: [700, 320, 470, 300], work: [968, 602] },
  { id: "memory", label: "阅览大厅", bounds: [50, 95, 500, 430], work: [362, 344] },
  { id: "skills", label: "编目室", bounds: [620, 50, 330, 250], work: [752, 247] },
  { id: "mcp", label: "代码工坊", bounds: [960, 54, 210, 168], work: [960, 240] },
  { id: "document", label: "写作工坊", bounds: [430, 650, 370, 250], work: [682, 822] },
  { id: "images", label: "档案室", bounds: [1280, 50, 280, 170], work: [1420, 220] },
  { id: "log", label: "机房 / 后台", bounds: [1360, 325, 150, 130], work: [1403, 455] },
  { id: "agent", label: "会议厅", bounds: [930, 650, 300, 210], work: [1057, 858] },
  { id: "task_queues", label: "借还台 / 交付", bounds: [700, 320, 470, 300], work: [968, 602] },
  { id: "break_room", label: "静思角", bounds: [1320, 740, 480, 220], work: [1560, 875] },
  { id: "alarm", label: "报警台", bounds: [1550, 50, 250, 170], work: [1615, 208] },
  { id: "schedule", label: "调度台", bounds: [1625, 325, 240, 130], work: [1625, 455] },
];

const NODES = [
  ["DO1", 620, 860], ["ME1", 300, 320], ["MC1", 1040, 610], ["IM1", 1435, 155],
  ["LG1", 1435, 430], ["SC1", 1555, 430], ["SK1", 756, 242], ["GW1", 860, 610],
  ["AG1", 1080, 820], ["BR1", 1560, 875], ["TQ1", 1735, 430], ["AL1", 1690, 155],
  ["H1", 470, 375], ["H2", 780, 375], ["H3", 1080, 375], ["H4", 1450, 375],
  ["V1", 620, 700], ["V2", 830, 620], ["V3", 1080, 700], ["V4", 1500, 760],
];

const EDGES = [
  ["DO1", "H1"], ["ME1", "H1"], ["MC1", "H2"], ["IM1", "AL1"], ["AL1", "SC1"],
  ["LG1", "H4"], ["SC1", "H4"], ["H1", "H2"], ["H2", "H3"], ["H3", "H4"],
  ["H1", "V1"], ["V1", "SK1"], ["H2", "V2"], ["V2", "GW1"], ["GW1", "V3"],
  ["V3", "AG1"], ["V3", "V4"], ["V4", "BR1"], ["V4", "TQ1"],
];

const NODE_BY_ID = new Map(NODES.map(([id, x, y]) => [id, { x, y }]));

function roomSvg() {
  return ROOMS.map((r) => {
    const [x, y, w, h] = r.bounds;
    return `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(64,140,255,0.10)" stroke="rgba(64,140,255,0.85)" stroke-width="3" stroke-dasharray="10 6" rx="8"/>
      <text x="${x + 10}" y="${y + 30}" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="26" font-weight="700" fill="#0b5cad">${r.label}</text>
      <text x="${x + 10}" y="${y + 56}" font-family="Consolas, monospace" font-size="16" fill="#4a7fb5">${r.id} · ${w}×${h}</text>
      <circle cx="${r.work[0]}" cy="${r.work[1]}" r="12" fill="rgba(255,120,40,0.9)" stroke="#fff" stroke-width="3"/>
    </g>`;
  }).join("");
}

function graphSvg() {
  const lines = EDGES.map(([a, b]) => {
    const na = NODE_BY_ID.get(a);
    const nb = NODE_BY_ID.get(b);
    return `<line x1="${na.x}" y1="${na.y}" x2="${nb.x}" y2="${nb.y}" stroke="rgba(40,200,120,0.9)" stroke-width="4" stroke-linecap="round"/>`;
  }).join("");
  const dots = NODES.map(([id, x, y]) => `
    <circle cx="${x}" cy="${y}" r="9" fill="#1fbf74" stroke="#fff" stroke-width="3"/>
    <text x="${x + 13}" y="${y + 5}" font-family="Consolas, monospace" font-size="15" fill="#0d7a4a">${id}</text>`).join("");
  return lines + dots;
}

function frameSvg(color) {
  return `
  <rect x="2" y="2" width="${W - 4}" height="${H - 4}" fill="${color}" stroke="rgba(0,0,0,0.35)" stroke-width="4"/>
  <text x="24" y="${H - 24}" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="20" fill="rgba(0,0,0,0.45)">
    图书馆场景布局参考 · 1920×1072 · 蓝框=房间/岗位 · 橙点=工作锚点 · 绿线=可行走主干
  </text>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${frameSvg("none")}
    ${roomSvg()}
    ${graphSvg()}
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(OUT_DIR, "layout-guide.png"));

  const svgSolid = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${frameSvg("#ffffff")}
    ${roomSvg()}
    ${graphSvg()}
  </svg>`;
  await sharp(Buffer.from(svgSolid)).png().toFile(join(OUT_DIR, "layout-guide-solid.png"));

  await writeFile(
    join(OUT_DIR, "README.md"),
    `# tools/library-ops —— 美术资源制作辅助

| 文件 | 用途 |
| --- | --- |
| \`layout-guide.png\` | 1920×1072 透明底布局参考（房间 / 工作锚点 / 可行走主干），喂给绘图模型做 img2img / ControlNet |
| \`layout-guide-solid.png\` | 同上，白底版本 |

生成：\`node scripts/export-library-ops-layout-guide.mjs\`

配套脚本：

- \`scripts/build-library-ops-scene.mjs\` —— 场景图接入（尺寸归一 + 生成/校验可行走掩码）
- \`scripts/build-library-ops-sprites.mjs\` —— 角色精灵表接入（去背景 + 切格 + 对齐 + WebP + 清单）
`,
    "utf8",
  );
  console.log(`已生成 ${join(OUT_DIR, "layout-guide.png")} 与 layout-guide-solid.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
