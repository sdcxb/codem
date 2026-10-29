# Dream 皮肤审计取证（D4，2026-10-28）

配套文档：`docs/audit/dream-skin-token-gap.md`（缺口清单，按使用次数排序）。

## 这三张图证明什么

在 release 构建里把皮肤切到 **梦幻（dream）**（`<html data-skin="dream">`），截取三个面：

1. `dream-1-settings-appearance.png` — 设置 → 外观（皮肤选择器本体）
2. `dream-2-chat.png` — 主对话（背景层 / 毛玻璃 / 消息气泡）
3. `dream-3-right-rail.png` — 右栏展开（Git 面板、滚动条、分割线）

用途：缺口清单说"哪些令牌在 dream 下退回默认浅色板"，这三张图用来判断**实际看起来有没有突兀**。
截图后已把皮肤切回 `默认`（`settings.skin-id = default`，读数据库核对过），没有改用户环境。

## 缺口摘要（详见审计文档）

```
CSS 里用到的令牌        : 306
skin-dream.css 定义      : 141
ThemeManager 运行时注入  : 53
缺口                     : 230   （颜色/表面类 86，结构/尺寸类 144）
使用次数最高的颜色缺口   : --accent-strong(77) · --warning-content(23) · --accent-border(21)
                           --error-border(20) · --accent-surface(19) · --error-surface(19)
```

## 下一步（等你拍板补哪些）

建议只补"表面/边框/阴影/强调"这一档（约 10–15 个），`--focus-ring-color` / `--caret-color`
这类应绑到 `--dream-accent` 而不是给死值；补完用这三张图 + 新截图比对。
