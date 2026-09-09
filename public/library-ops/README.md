# 图书馆插件美术资源

本目录是 `@codem/ui-library-ops` 使用的美术资源，按来源分子目录存放，
每个子目录都有 `SOURCE.md`（出处 / 许可 / 改动）与上游 LICENSE 原文（第三方资源）。

| 子目录 | 来源 | 美术许可 | 可商用 |
| --- | --- | --- | --- |
| `claw-library/` | [shengyu-meng/ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) | CC BY-NC-SA 4.0 | ❌ |
| `star-office/` | [ringhyacinth/Star-Office-UI](https://github.com/ringhyacinth/Star-Office-UI) | 仅非商业 | ❌ |
| `lobster-pet/` | [jiaweisibot/lobster-pet](https://github.com/jiaweisibot/lobster-pet) | MIT（仅设计参考，无美术资源） | ✅（设计） |
| `scenes/` | 本项目自有（AI 生成场景图预设） | 自有素材 | ✅ |

> ⚠️ **重要**：第三方子目录（`claw-library/`、`star-office/`）的美术资源**仅限非商业用途**。
> Codem 若需商业分发，必须替换这些资源 —— 可改用 `scenes/` 里的自有场景图
> （设置 → 场景图片），或用插件设置里的「等距矢量」场景风格（本项目自有代码绘制）。
>
> 完整许可说明与义务见 `docs/ASSET-LICENSES.md` 与根目录 `THIRD_PARTY_NOTICES.md`。

## 换场景图（不用改代码）

插件设置 → 「场景图片」→ 选内置预设，或点「上传图片」/ 直接把图片拖到场景上。
上传的图片存在浏览器 IndexedDB 里，不写进本目录、也不写入宿主数据。

## 重新生成

```bash
node scripts/sync-library-ops-assets.mjs --src <参考项目克隆目录>
```

脚本会把上游 PNG 转为 WebP（体积下降 5–10 倍）并写出 `SOURCE.md`，
同时刻意跳过 LimeZu 派生素材（其许可禁止再分发）。
