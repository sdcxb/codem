# tools/library-ops —— 美术资源制作辅助

| 文件 | 用途 |
| --- | --- |
| `layout-guide.png` | 1920×1072 透明底布局参考（房间 / 工作锚点 / 可行走主干），喂给绘图模型做 img2img / ControlNet |
| `layout-guide-solid.png` | 同上，白底版本 |

生成：`node scripts/export-library-ops-layout-guide.mjs`

配套脚本：

- `scripts/build-library-ops-scene.mjs` —— 场景图接入（尺寸归一 + 生成/校验可行走掩码）
- `scripts/build-library-ops-sprites.mjs` —— 角色精灵表接入（去背景 + 切格 + 对齐 + WebP + 清单）
