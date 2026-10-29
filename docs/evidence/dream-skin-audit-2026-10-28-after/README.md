# Dream 皮肤令牌补齐（D4 第二步，2026-10-28）

## 做了什么

按复审结论（`docs/audit/dream-skin-token-gap.md`）补了 **8 个「默认值写死字面色」的语义令牌**，
取值全部绑 `--dream-accent` / `--dream-text-main` / `--dream-c*`（ThemeManager 从用户背景图提取），
所以换背景图时强调色/边框/阴影会一起变：

```css
--accent-strong     --reasoning-accent   --text-base        --border-strong
--shadow-color      --shadow-color-soft  --text-on-status   --text-ramp-paper
```

**没有**去动那 35 个「自适应」令牌（`--accent-surface` / `--accent-border` / `--error-*` /
`--focus-ring-color` / `--hairline-ink` …）——它们的默认值本来就是
`color-mix(… var(--accent) …)`，dream 覆盖 `--accent` 后会自动跟随；重复定义反而会**冻住**。

## 取证：计算值（真机，dream 皮肤下）

```json
{
  "--accent-strong":  "color-mix(in srgb, #e88c9a 72%, #1a1a2e)",
  "--border-strong":  "color-mix(in srgb, #1a1a2e 34%, transparent)",
  "--shadow-color":   "color-mix(in srgb, #1a1a2e 16%, transparent)",
  "__dreamAccent":    ""
}
```

对比默认皮肤下 `--accent-strong` 是 **`#5b46cf`**（写死）——现在它跟着 dream 的强调色走了。
`__dreamAccent` 为空是因为本机没有设置背景图（ThemeManager 没注入），此时回落到 `#e88c9a` 默认粉紫。

完整读数见 `tokens-resolved.json`；截图见同目录 `dream-*.png`。取证后已切回默认皮肤（`skin-id=default` 已核对）。

## 判据

`src/test/dream-skin-tokens.test.ts`：

| # | 断言 |
|---|---|
| DREAM-TOK-1 | 8 个令牌在 `skin-dream.css` 里都有定义 |
| DREAM-TOK-2 | 取值必须绑 `var(--dream-accent|text-main|c*)`，不许写死新色值 |
| DREAM-TOK-3（反向对照） | 7 个自适应令牌**不许**在 dream 里重复定义；同时断言它们在默认样式里确实是派生值 |

## 第二批（13 个）：写死缺口清零

按你的要求「发现写死缺口就补，不考虑收益率」，把剩下 13 个「所有档位都写死字面色」的也补了：

```
--dropdown-hover  --surface-pressed  --field-border-hover  --tooltip-border
--tooltip-bg      --tooltip-text     --error-hover         --surface-content
--surface-opaque-raised  --surface-glass-raised  --shadow-inner-highlight
--terminal-bg     --window-close-bg
```

真机计算值（dream 皮肤下，`tokens-resolved-full.json`）：

| 令牌 | 计算值 |
|---|---|
| `--dropdown-hover` | `color-mix(in srgb, #1a1a2e 7%, transparent)` |
| `--tooltip-bg` | `color-mix(in srgb, #1a1a2e 96%, transparent)` |
| `--terminal-bg` | `rgba(30, 30, 46, .82)`（= `--dream-c1`） |
| `--surface-content` | `#fdf5f7`（= `--dream-c8`） |
| `--window-close-bg` | `#e81123`（= `--dream-c6`） |

判据 `src/test/dream-skin-tokens-full.test.ts`：`DREAM-TOK-4` 重算「所有档位都写死」的缺口集合
（除下面那个例外）必须为空；`DREAM-TOK-5` 第二批 13 个都定义且绑动态令牌。

**刻意不补的唯一一个**：`--skin-preview-hub-accent` —— 皮肤选择器里 Hub 皮肤的预览色块，
在 dream 作用域覆盖它反而是错的；`DREAM-TOK-4` 显式允许。

## 还剩什么

**写死缺口已清零。** `--shadow-raise-1..4` / `--shadow-bubble` / `--border-separator` 不需要单独定义 ——
它们引用 `var(--shadow-color)` / `color-mix(... var(--text-base))`，而两者已被 dream 覆盖 ⇒ 自动跟随。
