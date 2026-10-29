# Dream 皮肤令牌缺口 —— 复审（D4 第二步）

## 为什么复审

第一版把「skin-dream 没定义 且 ThemeManager 没注入」都算缺口，但其中一大类是**已自适应**的：
它们的默认值就是 `color-mix(… var(--accent) / var(--error) / var(--text-*) …)`，
dream 覆盖 `--accent` 后会**自动跟着变**，不需要补。真正要补的是**默认值写死字面色**的那些。

```
颜色类缺口           : 75
  A 会自适应（不用补）: 35
  B 写死字面色（要补）: 28
```

## A. 会自适应 —— 不用补（示例）

`--focus-ring-color`（10 次）：color-mix(in srgb, var(--accent) 75%, transparent)
`--scene-veil`（2 次）：color-mix(in srgb, var(--accent) 16%, transparent)
`--scene-veil-alt`（2 次）：color-mix(in srgb, var(--info) 10%, transparent)
`--accent-border-strong`（6 次）：color-mix(in srgb, var(--accent) 45%, transparent)
`--accent-surface`（16 次）：color-mix(in srgb, var(--accent) 8%, transparent)
`--chrome-surface`（1 次）：var(--bg-secondary)
`--scene-layer`（3 次）：radial-gradient(1100px 620px at 0% 0%, var(--scene-veil), transparent 
`--surface-raised`（5 次）：var(--bg-primary)
`--hairline-ink`（5 次）：color-mix(in srgb, var(--text-base) 8%, transparent)
`--row-hover`（3 次）：color-mix(in srgb, var(--text-base) 6%, transparent)
`--row-pressed`（3 次）：color-mix(in srgb, var(--text-base) 10%, transparent)
`--shadow-glow`（2 次）：0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent), 0 6px 20

## B. 写死字面色 —— 真缺口（按使用次数）

| 令牌 | 使用次数 | 默认值（写死） |
|---|---|---|
| `--accent-strong` | 65 | `#5b46cf` |
| `--shadow-color` | 22 | `rgb(31 31 30 / 14%)` |
| `--text-base` | 17 | `#1f1f1e` |
| `--shadow-color-soft` | 13 | `rgb(31 31 30 / 6%)` |
| `--text-on-status` | 13 | `#ffffff` |
| `--text-ramp-paper` | 7 | `#fffbe2` |
| `--border-strong` | 6 | `rgb(31 31 30 / 34%)` |
| `--shadow-raise-3` | 6 | `0 4px 8px var(--shadow-color-soft), 0 12px 32px var(--shadow` |
| `--shadow-raise-2` | 5 | `0 2px 4px var(--shadow-color-soft), 0 4px 12px var(--shadow-` |
| `--reasoning-accent` | 5 | `var(--accent)` |
| `--dropdown-hover` | 4 | `rgb(31 31 30 / 7%)` |
| `--border-separator` | 4 | `rgb(31 31 30 / 5%)` |
| `--error-hover` | 4 | `#cf222e` |
| `--surface-content` | 3 | `#ffffff` |
| `--shadow-raise-4` | 2 | `0 8px 16px var(--shadow-color-soft), 0 24px 48px var(--shado` |
| `--surface-glass-raised` | 2 | `color-mix(in srgb, #ffffff 94%, transparent)` |
| `--terminal-bg` | 2 | `#0d1117` |
| `--shadow-inner-highlight` | 2 | `inset 0 1px 0 rgb(255 255 255 / 8%)` |
| `--surface-opaque-raised` | 2 | `#ffffff` |
| `--surface-pressed` | 1 | `rgb(31 31 30 / 10%)` |
| `--window-close-bg` | 1 | `#e81123` |
| `--shadow-bubble` | 1 | `0 1px 2px var(--shadow-color-soft)` |
| `--tooltip-bg` | 1 | `rgb(38 37 35 / 96%)` |
| `--tooltip-text` | 1 | `#f7f7f5` |
| `--tooltip-border` | 1 | `rgb(31 31 30 / 20%)` |
| `--skin-preview-hub-accent` | 1 | `#ff6b00` |
| `--shadow-raise-1` | 1 | `0 1px 2px var(--shadow-color-soft), 0 1px 1px var(--shadow-c` |
| `--field-border-hover` | 1 | `rgb(31 31 30 / 20%)` |


## C. ????????**??**??????????????

? 8 ??????? **13 ?????????????** ??????

```css
--dropdown-hover  --surface-pressed  --field-border-hover  --tooltip-border
--tooltip-bg      --tooltip-text     --error-hover         --surface-content
--surface-opaque-raised  --surface-glass-raised  --shadow-inner-highlight
--terminal-bg     --window-close-bg
```

????? `--dream-accent` / `--dream-text-main` / `--dream-c*`?`--error-hover` ? `--error` ????????????

**??????**?`--skin-preview-hub-accent` ?? ???????? **Hub ???????**?
? dream ?????????????? `DREAM-TOK-4` ??????

?? `src/test/dream-skin-tokens-full.test.ts`?
`DREAM-TOK-4` ?????????????????????????????
`DREAM-TOK-5` ??? 13 ?????????????

> ??????`--shadow-raise-1..4` / `--shadow-bubble` / `--border-separator` ??????????
> ?????????????? `var(--shadow-color)` / `color-mix(... var(--text-base))`?
> ???????? dream ??? ? **????**?????????
