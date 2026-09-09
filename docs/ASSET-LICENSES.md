# 美术资源许可声明（Art Asset Licenses）

> Codem 的「图书馆运营监控」插件（`@codem/ui-library-ops`）集成了第三方项目的**像素美术资源**。
> 本文件是这些资源的完整许可声明与义务说明。**请在使用 / 分发 Codem 前阅读。**

---

## ⚠️ 一句话结论

**本插件集成的像素美术资源仅限非商业用途。** 若你需要商业分发 Codem（销售、SaaS、附带商业服务等），
必须做二者之一：

1. 在插件设置里把「场景风格」切换为 **等距矢量**（`sceneStyle: "iso"`）——该场景由本项目自绘，
   无第三方美术许可约束；或
2. 把 `public/library-ops/` 下的第三方资源替换为你自己的原创资源。

代码部分不受此限制：Codem 的插件代码本身是原创实现，只**消费**这些资源。

---

## 1. 资源清单与许可

| 子目录 | 来源项目 | 作者 | 美术许可 | 可商用 |
| --- | --- | --- | --- | --- |
| `public/library-ops/claw-library/` | [龙虾图书馆 / ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) | shengyu-meng | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | ❌ |
| `public/library-ops/star-office/` | [Star Office UI](https://github.com/ringhyacinth/Star-Office-UI) | Ring Hyacinth & Simon Lee | 仅限非商业（项目 LICENSE 第 2 节） | ❌ |
| `public/library-ops/lobster-pet/` | [lobster-pet](https://github.com/jiaweisibot/lobster-pet) | jiaweisibot | MIT（**仅设计参考，未收录美术资源**） | ✅（设计） |

每个子目录都包含：

- `SOURCE.md` —— 出处、原始路径、**改动说明**、许可义务
- 上游 LICENSE 原文（`LICENSE-ASSETS.md` / `LICENSE.txt` / `LICENSE-CODE.txt`）

---

## 2. ClawLibrary（CC BY-NC-SA 4.0）

**用途**：图书馆场景底图 + 家具层 + 两个角色（Capy-Claw / Cat-Claw）的 25 套动作精灵表。

### 已履行的义务

| 义务 | 履行方式 |
| --- | --- |
| **署名** | `public/library-ops/claw-library/SOURCE.md`、`THIRD_PARTY_NOTICES.md`、插件设置页「美术资源许可」卡、本文件 |
| **协议链接** | 上述各处均带 CC BY-NC-SA 4.0 链接 |
| **标明改动** | SOURCE.md 逐文件列出「PNG → WebP 重压缩（像素尺寸不变）」 |
| **相同方式共享** | 本目录资源未做内容改编（仅格式转换）；如你进一步改编，须以 CC BY-NC-SA 4.0 分发 |
| **非商业** | 插件设置页显式提示；本文件第 3 节说明替代方案 |

### 收录内容

- `scene-floor.webp`（2752×1536，原 `scene-floor.png` 5.8MB → 225KB）
- `scene-objects.webp`（2752×1536，原 5.6MB → 372KB）
- `walkable-mask.webp`（可行走掩码）
- `actors/capy/*.webp`（12 套动作）、`actors/cat/*.webp`（12 套动作），帧 128×128 @6fps

---

## 3. Star Office UI（仅限非商业）

**用途**：办公室场景与角色资源（当前作为可选场景素材保留；默认场景使用 ClawLibrary 图书馆）。

其 LICENSE 第 2 节明确：

> All art assets … are **non-commercial only**. They are for learning, demonstration,
> and idea sharing only. You may NOT use any art assets from this repository for
> commercial purposes.

### 刻意排除的素材

Star-Office-UI 内含 `guest_role_*.png` / `guest_anim_*.webp`（来自 LimeZu 的
「Animated Mini Characters 2 (Platform) [FREE]」）。LimeZu 的许可写明
**「You may not redistribute it or resell it」**，与「在开源仓库中再分发」冲突，
因此 **本项目不收录这些素材**（`scripts/sync-library-ops-assets.mjs` 中显式跳过）。

> 注：[lobster-pet](https://github.com/jiaweisibot/lobster-pet) 内嵌了 Star-Office-UI 的资源
> （其 LICENSE 第 25–33 行注明非商业），本项目据此也致谢该项目。

---

## 4. lobster-pet（MIT，仅设计参考）

本项目**未复制 lobster-pet 的任何代码或美术资源**，只借鉴其监控看板的信息架构与交互母题：

- `DetailPanel` 的「标题栏 + 卡片网格 + 场景嵌入」布局
- `StatusCard` / `TaskGrid` / `ActivityViz` / `TokenBar` / 实时事件流
- `MiniOffice` 把场景作为监控界面内一张卡片的做法

实现方式见 `docs/LIBRARY-OPS-PLUGIN.md` 第二节的逐项对照表。

---

## 5. 本项目自有资源（无第三方约束）

| 资源 | 位置 | 说明 |
| --- | --- | --- |
| 等距矢量场景（10 岗位 / 8 类家具 / 角色 SVG） | `src/plugins/library-ops/components/library/{iso,LibraryScene,SceneFurniture,CharacterActor}.tsx` | 全部由本项目代码程序化绘制，颜色只消费皮肤令牌，**无第三方许可约束** |
| 角色外观生成器 | `src/plugins/library-ops/data/characters.ts` | 12×4×5×6×6×4 = 34,560 种组合，程序化生成 |

---

## 6. 重新生成资源

```bash
# 需先克隆三个参考项目到同一目录
node scripts/sync-library-ops-assets.mjs --src <参考项目克隆目录>
```

脚本行为：

1. PNG → WebP 重压缩（30.1MB → 5.1MB，视觉无损）
2. 为每个来源写出 `SOURCE.md`（出处 / 改动 / 义务）
3. 复制上游 LICENSE 原文
4. **跳过 LimeZu 派生素材**（再分发受限）
5. 写出 `public/library-ops/README.md` 总索引

---

## 7. 相关文件

- `THIRD_PARTY_NOTICES.md` —— 第三方软件与资源总声明
- `public/library-ops/*/SOURCE.md` —— 每个来源的逐文件出处与改动
- `docs/LIBRARY-OPS-PLUGIN.md` —— 插件设计与参考项目分析
- `docs/LIBRARY-OPS-AUDIT.md` —— 插件审计报告
- 插件设置页 →「美术资源许可」卡 —— 运行时可见的许可提示
