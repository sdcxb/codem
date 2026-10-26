# Codem UI benchmark mock

这是 [13-UI-BENCHMARK-OMP.md](../project-guide/13-UI-BENCHMARK-OMP.md) 的 **P0 + P1 目标预演**，不是产品代码，也不是最终实现。

## 打开

直接双击 `ui-benchmark-mock.html`，或：

```powershell
start docs\design\ui-benchmark-mock.html
```

## 可切换状态

右下角有 mock 控制条（截图时用 `?clean=1` 隐藏）：

- `Dark` / `Light`：默认皮肤；
- `Hub` / `Dream`：另外两套皮肤的形状/配色预演；
- `设置`：整页设置（P2 目标）；
- `Ctrl K`：命令面板；
- `模型`：模型角色菜单。

也可以直接用 URL 参数：

```text
?theme=dark|light
?skin=default|hub|dream
?view=settings
?overlay=cmdk|model
?panel=1          # 展开底部终端面板
?focus=1          # 聚焦 Composer
?clean=1          # 隐藏 mock 控制条，用于截图
```

示例：

```text
docs/design/ui-benchmark-mock.html?theme=dark&clean=1
docs/design/ui-benchmark-mock.html?view=settings&theme=light&clean=1
docs/design/ui-benchmark-mock.html?overlay=cmdk&clean=1
docs/design/ui-benchmark-mock.html?panel=1&clean=1
```

## 预览图

| 文件 | 状态 |
|---|---|
| `ui-benchmark-mock-dark.jpg` | 默认 dark 工作台，1600×1000 |
| `ui-benchmark-mock-light.jpg` | 默认 light 工作台 |
| `ui-benchmark-mock-settings.jpg` | 整页设置 |
| `ui-benchmark-mock-cmdk.jpg` | 命令面板 |

## 边界

- 数据是 mock，不代表真实运行数据；
- 交互只覆盖视觉状态（主题/皮肤/设置/命令面板/模型菜单/底部面板），不是产品行为；
- 真实落地时必须按 `13` 的 Phase 0 截图 + computed contract 验收，不能以这个 HTML 的像素为准；
- Hub/Dream 只验证“同一套形状换色”是否成立，最终仍以产品皮肤 token 为准。
