# scenes/ —— 本项目内置的场景图（自有素材）

本目录存放**本项目自己的**场景图预设（不是第三方资源），用于插件的「场景图片」画廊。

| 文件 | 说明 |
| --- | --- |
| `ai-library-01.webp` | 2752×1536 图书馆场景图（AI 生成，按 `docs/art-prompts/01-图书馆场景.md` 的提示词生成） |
| `ai-library-01-thumb.webp` | 480×268 缩略图（设置面板画廊用） |

## 出处与许可

- **来源**：本项目使用者用图像生成模型（按仓库内提示词）生成，属**自有素材**；
- **权利**：不含任何第三方美术资源的再分发，**可用于商业场景**；
- **改动**：PNG → WebP 重压缩 + 统一到 2752×1536（`scripts/build-library-ops-scene-preset.mjs`）。

## 为什么是 2752×1536

插件的逻辑坐标系是 1920×1080、显示画布 1920×1072，贴图按 2752×1536 铺满。
预设只要保持这个尺寸/比例，角色站位、岗位标签、点击热区就与内置布局完全对齐，无需改任何坐标数据。

## 新增 / 替换预设

```bash
node scripts/build-library-ops-scene-preset.mjs --src <图片> --id <预设id> --label "<中文名>"
```

脚本会输出一段可直接粘贴到 `src/plugins/library-ops/data/pixel-art.ts` 的 `SCENE_PRESETS` 条目。

> 用户自己上传的图片**不放在这里**：它们保存在浏览器 IndexedDB（见 `src/plugins/library-ops/core/scene-image-db.ts`），
> 通过设置页「场景图片」→ 上传，或直接把图片拖到场景上。
