# Third-Party Software Notices

This file contains attribution notices for third-party software integrated into Codem.

> **美术资源（Art Assets）**：图书馆运营监控插件集成了第三方**像素美术资源**，
> 这些资源**仅限非商业用途**。完整清单、义务与商用替代方案见
> [`docs/ASSET-LICENSES.md`](docs/ASSET-LICENSES.md)。

---

## ClawLibrary（龙虾图书馆）— 美术资源

- **Project**: 龙虾图书馆 / ClawLibrary
- **Repository**: https://github.com/shengyu-meng/ClawLibrary
- **Author**: shengyu-meng
- **Art License**: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)（**非商业**）
- **Code License**: MIT
- **Integrated into**: `@codem/ui-library-ops`（`public/library-ops/claw-library/`）

### 收录内容与改动

图书馆场景底图 + 家具层 + 两个角色（Capy-Claw / Cat-Claw）的 25 套动作精灵表。
改动：PNG → WebP 重压缩（像素尺寸不变，30.1MB → 5.1MB）。
逐文件出处见 `public/library-ops/claw-library/SOURCE.md`。

### 义务

署名「龙虾图书馆 / ClawLibrary」+ 协议链接 + 标明改动 + 相同方式共享 + **不得商业使用**。

---

## Star Office UI — 美术资源

- **Project**: Star Office UI
- **Repository**: https://github.com/ringhyacinth/Star-Office-UI
- **Authors**: Ring Hyacinth & Simon Lee
- **Art License**: **仅限非商业**（LICENSE 第 2 节）
- **Code License**: MIT
- **Integrated into**: `@codem/ui-library-ops`（`public/library-ops/star-office/`）

### 收录内容与改动

办公室场景背景、猫咪 / 星星角色、机房、海报、绿植、咖啡机等资源（WebP 重压缩）。

### 刻意排除

`guest_role_*.png` / `guest_anim_*.webp` 来自 **LimeZu**（Animated Mini Characters 2
[Platform] [FREE]），其许可禁止再分发（"You may not redistribute it or resell it"），
故本项目不收录。

---

## lobster-pet — 设计参考（MIT）

- **Project**: Lobster Pet — OpenClaw Desktop Pet + Agent Dashboard
- **Repository**: https://github.com/jiaweisibot/lobster-pet
- **Author**: jiaweisibot
- **License**: MIT

### 借鉴内容

**未复制任何代码或美术资源**，只借鉴监控看板的信息架构与交互母题：
`DetailPanel` 的「标题栏 + 卡片网格 + 场景嵌入」布局、`StatusCard` / `TaskGrid` /
`ActivityViz` / `TokenBar` / 实时事件流、`MiniOffice` 把场景作为卡片嵌入的做法。
逐项对照见 `docs/LIBRARY-OPS-PLUGIN.md` 第二节。

---

## Petdex

- **Project**: Petdex (Desktop Pet Marketplace)
- **Repository**: https://github.com/crafter-station/petdex
- **License**: MIT License
- **Copyright**: (c) Petdex Contributors

### MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Integration Description

Codem integrates Petdex's pet package format and public manifest API:

1. **Pet Package Format** (`pet.json` + `spritesheet`): Codem adopts Petdex's
   open pet package format for representing pet metadata and sprite animations.
   The type definitions (`PetDefinition`, `PetAnimationFrame`) are designed to
   be compatible with Petdex's format specification.

2. **Manifest API**: Codem fetches the public pet catalog from Petdex's
   manifest API endpoint (`https://petdex.dev/api/manifest`) to allow users
   to browse and download pets from the Petdex marketplace.

3. **Based on Petdex**: Codem's pet system (`src/core/pet/`,
   `src/components/Pet*.tsx`) is based on the Petdex open-source project and
   adapted for Codem's architecture. The integration includes calling Petdex's
   public marketplace API, adopting its pet package format, and modifying
   the implementation to fit Codem's Agent event model.

### Attribution

This product includes software developed by the Petdex project
(https://github.com/crafter-station/petdex).
