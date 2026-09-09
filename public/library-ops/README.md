# 图书馆插件美术资源（第三方）

本目录是 `@codem/ui-library-ops` 使用的**第三方像素美术资源**，按来源分子目录存放，
每个子目录都有 `SOURCE.md`（出处 / 许可 / 改动）与上游 LICENSE 原文。

| 子目录 | 来源 | 美术许可 | 可商用 |
| --- | --- | --- | --- |
| `claw-library/` | [shengyu-meng/ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) | CC BY-NC-SA 4.0 | ❌ |
| `star-office/` | [ringhyacinth/Star-Office-UI](https://github.com/ringhyacinth/Star-Office-UI) | 仅非商业 | ❌ |
| `lobster-pet/` | [jiaweisibot/lobster-pet](https://github.com/jiaweisibot/lobster-pet) | MIT（仅设计参考，无美术资源） | ✅（设计） |

> ⚠️ **重要**：本目录的美术资源**仅限非商业用途**。Codem 若需商业分发，
> 必须替换本目录全部资源（可用插件设置里的「等距矢量」场景风格作为替代，
> 它由本项目自有代码绘制，无第三方许可约束）。
>
> 完整许可说明与义务见 `docs/ASSET-LICENSES.md` 与根目录 `THIRD_PARTY_NOTICES.md`。

## 重新生成

```bash
node scripts/sync-library-ops-assets.mjs --src <参考项目克隆目录>
```

脚本会把上游 PNG 转为 WebP（体积下降 5–10 倍）并写出 `SOURCE.md`，
同时刻意跳过 LimeZu 派生素材（其许可禁止再分发）。
