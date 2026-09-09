# 美术资源来源：ClawLibrary

- **项目**：龙虾图书馆 / ClawLibrary
- **仓库**：https://github.com/shengyu-meng/ClawLibrary
- **作者**：shengyu-meng
- **美术许可**：Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
  （CC BY-NC-SA 4.0）—— 见同目录 `LICENSE-ASSETS.md`
- **代码许可**：MIT —— 见同目录 `LICENSE-CODE.txt`

## 本目录包含

| 文件 | 原始路径 | 改动 |
| --- | --- | --- |
| `scene-floor.webp` | `public/assets/packs/default/2026-03-09/scene-floor.png` | PNG → WebP（质量 86），像素尺寸不变 |
| `scene-objects.webp` | 同上 `scene-objects.png` | 同上 |
| `walkable-mask.webp` | 同上 `reference-walkable.png` | PNG → WebP（质量 80），像素尺寸不变 |
| `actors/capy/*.webp` | `public/assets/generated/actors/capy-claw-emoji-v2/sheets/*-spritesheet.png` | PNG → WebP（质量 82），像素尺寸不变 |
| `actors/cat/*.webp` | `public/assets/generated/actors/cat-claw-emoji-v1/sheets/*-spritesheet.png` | 同上 |

## 许可义务（务必遵守）

1. **署名**：标注「龙虾图书馆 / ClawLibrary」并链接 CC BY-NC-SA 4.0 协议。
2. **非商业**：**不得用于商业用途**。Codem 若要商业分发，必须替换本目录全部资源。
3. **相同方式共享**：对本目录资源的改编（如调色、裁切）需以 CC BY-NC-SA 4.0 分发。
4. **标明改动**：见上表「改动」列。

## 角色动作表

- `capy`（Capy-Claw）：work, read, idea, repair, error, sleep, coffee, rest, walk, stand_front, stand_back, lie_flat
- `cat`（Cat-Claw）：work, idea, repair, error, sleep, coffee, walk, stand_front, stand_back, lie_side, front, game

帧尺寸 128×128，逐帧 6 fps，列/行数见上游 `manifest.json`（已内联到 `src/plugins/library-ops/data/pixel-art.ts`）。
