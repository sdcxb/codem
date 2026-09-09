/**
 * 图书馆插件美术资源同步脚本（开发工具，产物已提交到仓库）
 *
 * 把第三方像素美术资源从上游仓库转换/压缩到 `public/library-ops/`：
 * - PNG → WebP（体积下降 5–10 倍，视觉无损）
 * - 每个来源目录写入 `SOURCE.md`（出处、许可、改动说明）
 * - 复制上游 LICENSE 原文
 *
 * 用法：
 *   node scripts/sync-library-ops-assets.mjs --src <参考项目克隆目录>
 * 其中 <参考项目克隆目录> 需包含 ClawLibrary / Star-Office-UI / lobster-pet。
 *
 * ⚠️ 许可提醒：这些美术资源**仅限非商业用途**（见 docs/ASSET-LICENSES.md）。
 * 商用必须替换为自有资源。脚本会刻意跳过 LimeZu 派生的 guest_* 素材
 * （LimeZu 许可禁止再分发）。
 */
import { mkdir, copyFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "library-ops");

const args = process.argv.slice(2);
const srcArg = args.indexOf("--src");
const SRC = srcArg >= 0 ? args[srcArg + 1] : process.env.LIBOPS_REF_DIR;
if (!SRC) {
  console.error("用法: node scripts/sync-library-ops-assets.mjs --src <参考项目克隆目录>");
  process.exit(1);
}

let converted = 0;
let bytesIn = 0;
let bytesOut = 0;

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

/** PNG/JPG → WebP（保留原始像素尺寸，供高倍缩放） */
async function toWebp(srcPath, outPath, { quality = 88, resize } = {}) {
  if (!existsSync(srcPath)) {
    console.warn(`  [skip] 源文件不存在: ${srcPath}`);
    return false;
  }
  await ensureDir(dirname(outPath));
  let pipe = sharp(srcPath);
  if (resize) pipe = pipe.resize(resize.width, resize.height, { fit: "fill" });
  await pipe.webp({ quality, effort: 6 }).toFile(outPath);
  const inSize = (await stat(srcPath)).size;
  const outSize = (await stat(outPath)).size;
  bytesIn += inSize;
  bytesOut += outSize;
  converted++;
  console.log(`  ${basename(outPath).padEnd(34)} ${(inSize / 1024).toFixed(0).padStart(6)}KB → ${(outSize / 1024).toFixed(0).padStart(5)}KB`);
  return true;
}

async function copyRaw(srcPath, outPath) {
  if (!existsSync(srcPath)) {
    console.warn(`  [skip] 源文件不存在: ${srcPath}`);
    return false;
  }
  await ensureDir(dirname(outPath));
  await copyFile(srcPath, outPath);
  return true;
}

// ============ 1. ClawLibrary（图书馆场景 + 双角色精灵）============
// 出处：https://github.com/shengyu-meng/ClawLibrary
// 美术许可：CC BY-NC-SA 4.0（LICENSE-ASSETS.md）
const CLAW = join(SRC, "ClawLibrary");
const CLAW_OUT = join(OUT, "claw-library");

const CLAW_ACTORS = {
  capy: ["work", "read", "idea", "repair", "error", "sleep", "coffee", "rest", "walk", "stand_front", "stand_back", "lie_flat"],
  // cat-claw 没有 read / rest 两套（上游清单如此），用 idea / stand_front 顶替
  cat: ["work", "idea", "repair", "error", "sleep", "coffee", "walk", "stand_front", "stand_back", "lie_side", "front", "game"],
};

async function syncClawLibrary() {
  console.log("\n[1/3] ClawLibrary（图书馆场景 + 角色精灵，CC BY-NC-SA 4.0）");
  const pack = join(CLAW, "public", "assets", "packs", "default", "2026-03-09");
  await toWebp(join(pack, "scene-floor.png"), join(CLAW_OUT, "scene-floor.webp"), { quality: 86 });
  await toWebp(join(pack, "scene-objects.png"), join(CLAW_OUT, "scene-objects.webp"), { quality: 86 });
  await toWebp(join(pack, "reference-walkable.png"), join(CLAW_OUT, "walkable-mask.webp"), { quality: 80 });

  for (const [variant, actions] of Object.entries(CLAW_ACTORS)) {
    const dir = join(CLAW, "public", "assets", "generated", "actors", variant === "capy" ? "capy-claw-emoji-v2" : "cat-claw-emoji-v1", "sheets");
    for (const action of actions) {
      await toWebp(join(dir, `${action}-spritesheet.png`), join(CLAW_OUT, "actors", variant, `${action}.webp`), { quality: 82 });
    }
  }

  await copyRaw(join(CLAW, "LICENSE-ASSETS.md"), join(CLAW_OUT, "LICENSE-ASSETS.md"));
  await copyRaw(join(CLAW, "LICENSE"), join(CLAW_OUT, "LICENSE-CODE.txt"));
  await writeFile(
    join(CLAW_OUT, "SOURCE.md"),
    `# 美术资源来源：ClawLibrary

- **项目**：龙虾图书馆 / ClawLibrary
- **仓库**：https://github.com/shengyu-meng/ClawLibrary
- **作者**：shengyu-meng
- **美术许可**：Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
  （CC BY-NC-SA 4.0）—— 见同目录 \`LICENSE-ASSETS.md\`
- **代码许可**：MIT —— 见同目录 \`LICENSE-CODE.txt\`

## 本目录包含

| 文件 | 原始路径 | 改动 |
| --- | --- | --- |
| \`scene-floor.webp\` | \`public/assets/packs/default/2026-03-09/scene-floor.png\` | PNG → WebP（质量 86），像素尺寸不变 |
| \`scene-objects.webp\` | 同上 \`scene-objects.png\` | 同上 |
| \`walkable-mask.webp\` | 同上 \`reference-walkable.png\` | PNG → WebP（质量 80），像素尺寸不变 |
| \`actors/capy/*.webp\` | \`public/assets/generated/actors/capy-claw-emoji-v2/sheets/*-spritesheet.png\` | PNG → WebP（质量 82），像素尺寸不变 |
| \`actors/cat/*.webp\` | \`public/assets/generated/actors/cat-claw-emoji-v1/sheets/*-spritesheet.png\` | 同上 |

## 许可义务（务必遵守）

1. **署名**：标注「龙虾图书馆 / ClawLibrary」并链接 CC BY-NC-SA 4.0 协议。
2. **非商业**：**不得用于商业用途**。Codem 若要商业分发，必须替换本目录全部资源。
3. **相同方式共享**：对本目录资源的改编（如调色、裁切）需以 CC BY-NC-SA 4.0 分发。
4. **标明改动**：见上表「改动」列。

## 角色动作表

- \`capy\`（Capy-Claw）：${CLAW_ACTORS.capy.join(", ")}
- \`cat\`（Cat-Claw）：${CLAW_ACTORS.cat.join(", ")}

帧尺寸 128×128，逐帧 6 fps，列/行数见上游 \`manifest.json\`（已内联到 \`src/plugins/library-ops/data/pixel-art.ts\`）。
`,
    "utf8",
  );
}

// ============ 2. Star-Office-UI（办公室场景 + 角色）============
// 出处：https://github.com/ringhyacinth/Star-Office-UI
// 美术许可：非商业（LICENSE 第 2 节）
// ⚠️ 刻意跳过 guest_* 素材：它们来自 LimeZu，其许可禁止再分发。
const STAR = join(SRC, "Star-Office-UI", "frontend");
const STAR_OUT = join(OUT, "star-office");

const STAR_FILES = [
  ["office_bg.webp", "office-bg.webp", { quality: 88 }],
  ["office_bg_small.webp", "office-bg-hd.webp", { quality: 90 }],
  ["cats-spritesheet.webp", "cats.webp", { quality: 88 }],
  ["star-idle-v5.png", "star-idle.webp", { quality: 86 }],
  ["star-working-spritesheet-grid.webp", "star-working.webp", { quality: 86 }],
  ["serverroom-spritesheet.webp", "serverroom.webp", { quality: 88 }],
  ["posters-spritesheet.webp", "posters.webp", { quality: 86 }],
  ["plants-spritesheet.webp", "plants.webp", { quality: 86 }],
  ["flowers-bloom-v2.webp", "flowers.webp", { quality: 86 }],
  ["coffee-machine-v3-grid.webp", "coffee-machine.webp", { quality: 84 }],
  ["desk-v3.webp", "desk.webp", { quality: 88 }],
  ["sofa-idle-v3.png", "sofa-idle.webp", { quality: 88 }],
  ["sofa-shadow-v1.png", "sofa-shadow.webp", { quality: 88 }],
  ["error-bug-spritesheet-grid.webp", "error-bug.webp", { quality: 84 }],
  ["sync-animation-v3-grid.webp", "sync-animation.webp", { quality: 84 }],
];

async function syncStarOffice() {
  console.log("\n[2/3] Star-Office-UI（办公室场景 + 角色，仅限非商业）");
  for (const [from, to, opts] of STAR_FILES) {
    await toWebp(join(STAR, from), join(STAR_OUT, to), opts);
  }
  await copyRaw(join(SRC, "Star-Office-UI", "LICENSE"), join(STAR_OUT, "LICENSE.txt"));
  await writeFile(
    join(STAR_OUT, "SOURCE.md"),
    `# 美术资源来源：Star-Office-UI

- **项目**：Star Office UI
- **仓库**：https://github.com/ringhyacinth/Star-Office-UI
- **作者**：Ring Hyacinth & Simon Lee
- **美术许可**：**仅限非商业**（学习 / 演示 / 交流）—— 见同目录 \`LICENSE.txt\` 第 2 节
- **代码许可**：MIT

> 上游亦被 [jiaweisibot/lobster-pet](https://github.com/jiaweisibot/lobster-pet) 内嵌
> （其 LICENSE 第 25–33 行注明「Star-Office-UI assets: non-commercial use only」）。
> 本项目同时致谢两个项目。

## 本目录包含

| 文件 | 原始文件 | 改动 |
| --- | --- | --- |
${STAR_FILES.map(([from, to]) => `| \`${to}\` | \`frontend/${from}\` | WebP 重压缩 |`).join("\n")}

## 刻意排除

- \`guest_role_*.png\` / \`guest_anim_*.webp\`：这些是 **LimeZu** 的
  「Animated Mini Characters 2 (Platform) [FREE]」素材，LimeZu 许可明确
  **「You may not redistribute it or resell it」**，因此本项目不收录。

## 许可义务

1. **署名**：标注 Ring Hyacinth & Simon Lee 与仓库链接。
2. **非商业**：不得用于商业用途；商业分发必须替换为自有资源。
3. 保留上游 LICENSE 原文（本目录 \`LICENSE.txt\`）。
`,
    "utf8",
  );
}

// ============ 3. lobster-pet（监控看板设计参考）============
const LOBSTER = join(SRC, "lobster-pet");
const LOBSTER_OUT = join(OUT, "lobster-pet");

async function syncLobsterPet() {
  console.log("\n[3/3] lobster-pet（监控看板设计参考 + 其内嵌办公室场景）");
  await ensureDir(LOBSTER_OUT);
  await copyRaw(join(LOBSTER, "LICENSE"), join(LOBSTER_OUT, "LICENSE.txt"));
  // 其 public/office/* 与 Star-Office-UI 同源，不重复收录美术资源
  await writeFile(
    join(LOBSTER_OUT, "SOURCE.md"),
    `# 设计参考来源：lobster-pet

- **项目**：Lobster Pet — OpenClaw Desktop Pet + Agent Dashboard
- **仓库**：https://github.com/jiaweisibot/lobster-pet
- **作者**：jiaweisibot
- **代码许可**：MIT（见同目录 \`LICENSE.txt\`）

## 本项目借鉴的内容

**只借鉴信息架构与交互母题，不复制其代码**：

- \`DetailPanel\` 的「标题栏 + 卡片网格 + 场景嵌入」布局
- \`StatusCard\` / \`TaskGrid\` / \`ActivityViz\`（14 天热力图 + 会话类型环形图 +
  24 小时活跃柱状图）/ \`TokenBar\` / 实时事件流
- \`MiniOffice\` 把场景作为监控界面内一个卡片的做法

## 关于其美术资源

lobster-pet 的 \`public/office/*\` 像素资源与 **Star-Office-UI** 同源
（其 LICENSE 第 25–33 行已注明为非商业用途），因此本项目的美术资源统一从
Star-Office-UI 收录（见 \`../star-office/\`），此处不重复收录。
`,
    "utf8",
  );
}

// ============ 汇总 ============
async function writeIndex() {
  await writeFile(
    join(OUT, "README.md"),
    `# 图书馆插件美术资源（第三方）

本目录是 \`@codem/ui-library-ops\` 使用的**第三方像素美术资源**，按来源分子目录存放，
每个子目录都有 \`SOURCE.md\`（出处 / 许可 / 改动）与上游 LICENSE 原文。

| 子目录 | 来源 | 美术许可 | 可商用 |
| --- | --- | --- | --- |
| \`claw-library/\` | [shengyu-meng/ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) | CC BY-NC-SA 4.0 | ❌ |
| \`star-office/\` | [ringhyacinth/Star-Office-UI](https://github.com/ringhyacinth/Star-Office-UI) | 仅非商业 | ❌ |
| \`lobster-pet/\` | [jiaweisibot/lobster-pet](https://github.com/jiaweisibot/lobster-pet) | MIT（仅设计参考，无美术资源） | ✅（设计） |

> ⚠️ **重要**：本目录的美术资源**仅限非商业用途**。Codem 若需商业分发，
> 必须替换本目录全部资源（可用插件设置里的「等距矢量」场景风格作为替代，
> 它由本项目自有代码绘制，无第三方许可约束）。
>
> 完整许可说明与义务见 \`docs/ASSET-LICENSES.md\` 与根目录 \`THIRD_PARTY_NOTICES.md\`。

## 重新生成

\`\`\`bash
node scripts/sync-library-ops-assets.mjs --src <参考项目克隆目录>
\`\`\`

脚本会把上游 PNG 转为 WebP（体积下降 5–10 倍）并写出 \`SOURCE.md\`，
同时刻意跳过 LimeZu 派生素材（其许可禁止再分发）。
`,
    "utf8",
  );
}

// ============ 执行 ============
async function main() {
  console.log(`源目录: ${SRC}`);
  if (!existsSync(SRC)) {
    console.error("源目录不存在");
    process.exit(1);
  }
  await ensureDir(OUT);
  await syncClawLibrary();
  await syncStarOffice();
  await syncLobsterPet();
  await writeIndex();
  console.log(`\n完成：${converted} 个文件转 WebP，${(bytesIn / 1024 / 1024).toFixed(1)}MB → ${(bytesOut / 1024 / 1024).toFixed(1)}MB`);
  const files = await readdir(OUT);
  console.log(`输出目录: ${OUT}\n顶层条目: ${files.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
