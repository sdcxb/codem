# 颜色角色下限的阈值漂移评估（GAP-LIST O-39 第②步）

**结论先说**：把 `tools/audit/scan-color-roles.mjs` 的 sRGB 线性化阈值从**旧值 0.03928**
统一到**勘误后的 0.04045**，**53 对 × 2 档主题 = 106 条读数逐条零漂移**：
最大差 `0.000000000`、超过 1e-3 的 **0 条**、通过/不通过**翻转 0 条**、已登记基数**无一翻转**
⇒ **可接受，不需要重写任何基数**。

- 阈值口径（哪个对、为什么）：`src/core/theme/contrast-checker.ts` 文件头注释 + 唯一来源文件
  `src/core/theme/wcag-luminance.json`
- 判据：`src/test/contrast-luminance-single-source.test.ts`（`CR-CONTRAST-1`）
- 变异自证：`tools/mutate/specs/contrast-191.mjs` / `tools/mutate/results/contrast-191.json`

---

## 1. 怎么跑的（可复核）

被测量的对象是**这道门禁自己的 106 条实算读数**，也就是 `--json` 输出的 `findings[]`
（`{ key, theme, ratio, floor }`，`key` = `角色|表面`）。

收敛之后阈值只有一处来源，所以复现只需要**改那一个数**（这也是本次评估选的跑法：
改唯一来源 ⇒ 产品侧与审计侧同时跟着变，测的就是"统一之后会怎样"）：

```powershell
# ① 把 src/core/theme/wcag-luminance.json 的 srgbLinearThreshold 临时改成 0.03928
node tools/audit/scan-color-roles.mjs --json > %TEMP%\cr-final-3928.json
# ② 改回 0.04045（勘误后的值，正式口径）
node tools/audit/scan-color-roles.mjs --json > %TEMP%\cr-final-4045.json
# ③ 按 `key|theme` 逐条对齐、比 ratio
```

两次都打印 106 条 `findings`（53 对 × 亮/暗两档），`violations` 两次都是 **0**、
`unresolvedKeys` 两次都是 **49**（预算 49），两次 `exit 0`。
所以**通过集合的差集是空集**、**通过数都是 106/106**。

> 收敛**之前**也量过一次（直接改 `tools/audit/scan-color-roles.mjs` 里那一行字面量），
> 读数与上面**逐位相同**（106 条、最大差 0、0 条翻转）。
> 三次跑（旧写法 0.03928 / 旧写法 0.04045 / 新写法读 JSON 的 0.04045）结论一致：
> `53 对全部已登记且过对比度下限；未解析 49（预算 49）`。

## 2. 逐条差值的读数

| 指标 | 读数 |
| --- | --- |
| 比较条目数 | **106**（= 53 对 × 2 档） |
| 最大 \|Δratio\| | **0.000000000**（连 1e-9 都没有；不是"很小"，是**两位阈值对这批输入逐位相同**） |
| \|Δratio\| > 1e-3 的对数 | **0** |
| \|Δratio\| > 1e-4 的对数 | **0** |
| 通过/不通过翻转的对数 | **0** |
| `violations` 差集 | **空集**（两次都是 `[]`） |
| `unresolvedKeys` | 两次都是 **49**（预算 49，无变化） |

最紧的 6 对（两次读数逐条相同，这也是"最容易被漂移翻掉"的那一批）：

```
dark  3.99:1  下限 3     --text-on-accent|--accent
light 4.57:1  下限 4.5   --error|--error-surface
light 4.63:1  下限 3     --text-on-accent|--window-close-bg
dark  4.63:1  下限 3     --text-on-accent|--window-close-bg
light 4.65:1  下限 4.5   --error-content|--error-surface-strong
light 4.66:1  下限 4.5   --info|--info-surface
```

注意 `light 4.57:1 下限 4.5` 距离下限只有 **0.07**：如果阈值会造成哪怕 1e-3 量级的漂移，
这里就是第一个被翻掉的地方。实测差为 0。

## 3. 为什么恰好是 0（不是运气，是取值域决定的）

两个阈值只在**一个极窄窗口**里分道扬镳：`s <= t ? s/12.92 : ((s+0.055)/1.055)^2.4`
两条分支的分界点从 `0.03928` 挪到 `0.04045`，所以只有

```
s ∈ (0.03928, 0.04045]    ⟺    通道值 c = 255·s ∈ (10.0164, 10.31475]   （窗口宽 0.298）
```

之间的通道取值会算出不同的线性值。而：

- **整数通道永远落不进去**（`10` ≤ 10.0164 走线性支、`11` > 10.31475 走幂支，两支都不变）；
- 门禁里只有 `over()` 的 **α 合成**会产生小数通道（`color-mix` 的预乘还原除下来也是小数）。
  本次 106 条里参与计算的通道值**没有一条落进这个窗口**，于是逐位相同。

理论上界（把 0–256 按 0.01 步长全扫一遍求最大单通道差）：

```
单通道线性值最大差 = 7.5544e-7   （出现在 c = 10.02）
→ |ΔL| ≤ 7.5544e-7（三个系数之和为 1）
→ |Δratio| = |Δ(L_hi − L_lo)| / (L_lo + 0.05) ≤ 2 × 7.5544e-7 / 0.05 ≈ 3.0e-5
```

即**任何输入下**对比度读数的漂移都 `< 3.1e-5`。这对本门禁意味着两件事：
① 判定用的是 `ratio + 1e-9 < floor`，3.1e-5 的量级**不可能**翻动任何一对的通过性（除非某条读数
距离下限不足 3.1e-5，本仓库最紧的一条离下限 0.07，差三个数量级）；
② 门禁报数字只到两位小数，3.1e-5 也**不可能**翻动 `toFixed(2)`。

## 4. 已登记基数有没有翻转

`tools/audit/color-roles.json`（这道门的基数文件）里存的是 **①53 对 + 1 条历史遗留键** 与
**②`unresolvedBudget: 49`（预算）**，**不存任何对比度读数** ⇒ 阈值变化本身动不到它。

唯一"把读数烤进基数"的地方是 `src/test/color-roles.test.ts` 的 `CR-8`：它要求注册表
`_why` 文案里写着的**按真实父面复算的两位小数**必须等于复算值，共三处：

| 登记键 | 亮 / 暗（两位小数） |
| --- | --- |
| `--info-content|--info-surface` | 5.29 / 5.78 |
| `--success-content|--success-surface` | 5.96 / 5.77 |
| `--accent-strong|--bg-primary` | 6.52 / 8.06 |

**实测**：把 `.mjs` 的阈值换成 0.04045 后单跑 `npx vitest run src/test/color-roles.test.ts`
⇒ **8 passed (8)**，`CR-8` 全绿 ⇒ 三处两位小数读数**一处都没漂**。

> 顺带如实记录一个**与本次改动无关**的既存现象（我只报告、不改动，因为它属于别的条目的范围）：
> 注册表里有 **54 条**登记键，而当前代码里只扫得出 **53 对** ——
> `--text-secondary|--bg-primary` 这条已经不在代码里了。`--check` 不检查"登记了但已消失"的键
> （只有 `--write` 不带 `--force` 才会因此退出 1）。本次阈值收敛与这条无关，也不因它改变。

## 5. 结论

**可接受，统一到 0.04045。** 理由按证据排序：

1. **口径上只有 0.04045 是对的**：WCAG 2.1 勘误后用 0.04045，0.03928 是 2.0 初版/1.0 的旧值。
   "两份都对、所以不用合并"是不成立的 —— 这与本仓「同一规则只许一处实现」的纪律直接冲突。
2. **合并的代价实测为零**：106 条读数逐位相同，通过集合差集为空，已登记基数（含 `CR-8` 钉住的
   三处两位小数）无一翻转。
3. **即使以后有输入落进那个窗口，漂移也被界住**：`|Δratio| < 3.1e-5`，比门禁的判定粒度
   （两位小数 / 下限差 0.07）小三个数量级。

## 6. 谁在读这个阈值（收敛后的形态）

| 运行面 | 文件 | 读法 |
| --- | --- | --- |
| 产品（Vite 打包 TS） | `src/core/theme/contrast-checker.ts` | `import { srgbLinearThreshold } from "./wcag-luminance.json"` |
| 审计（纯 node，不打包） | `tools/audit/scan-color-roles.mjs` | `readFileSync` + `JSON.parse` 同一个 JSON |
| 三个既有判据 | `css-integrity.test.ts` / `light-theme-contrast.test.ts` / `style-token-gates.test.ts` | `import { channelLinear } from "../core/theme/contrast-checker"`（不再各自镜像） |
| 唯一数值来源 | `src/core/theme/wcag-luminance.json` | `srgbLinearThreshold` |

字面量清单（`CR-CONTRAST-1` 用解析式对账守住）：除 `wcag-luminance.json` 外，
`src/**` 与 `tools/**` 的**代码**里一份阈值字面量都不许有（注释与 `.md` 文档用来讲清道理不算 ——
门禁先剥注释再扫；唯一例外是 `tools/mutate/results/contrast-191.json`，它是变异运行器
逐字写出的"被改坏的原文"快照，不含旧值就无法复核，例外条目逐条写在判据的例外表里且命中数被钉死）。
