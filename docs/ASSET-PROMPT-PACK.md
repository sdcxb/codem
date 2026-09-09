# 图书馆插件 · 美术素材生成提示词包（ASSET PROMPT PACK）

> **👉 只想赶紧开画？直接看 [`art-prompts/`](./art-prompts/00-怎么用.md)** ——
> 那里每个文件只有一个提示词，全选复制粘贴即可；生成后把图片丢进 `C:\mimo-gui\.art-inbox\`，
> 剩下的切图 / 去背景 / 对齐 / 接入由我处理。
> **本文件是技术参考**（精确规格、为什么这么写、工具链细节），需要时再翻。

> 用途：用绘图大模型生成**自有版权**的图书馆场景与角色素材，替换当前集成进来的
> 第三方非商业素材（ClawLibrary / Star-Office-UI），从而解除非商业限制。
>
> 本文件里的所有尺寸、配色、网格、命名都**实测自当前渲染器与上游素材**，
> 照抄即可**直接接入、无需改代码**（或只需登记一行清单）。

---

## 0. 先说结论：能做到什么程度

| 素材类型 | 绘图模型能否胜任 | 建议做法 |
| --- | --- | --- |
| **场景底图**（房间/地板/墙/家具） | ✅ 很擅长 | 一次生成，按本文规格出图，直接替换 |
| **家具/装饰层**（透明底） | ✅ 可以 | 生成后去背景，或直接画在底图里（更简单） |
| **角色立绘/设计稿** | ✅ 很擅长 | 先定 1 个角色，再定配色与道具 |
| **角色动作精灵表** | ⚠️ **弱项** | **不要指望一次出完美精灵表**。推荐「单动作、纯色背景、固定 seed、逐帧生成 → 脚本切格对齐」，或用「网格图 + 脚本切分 + 人工挑选」 |
| **逐帧动画一致性** | ⚠️ 弱项 | 用同一张参考图 + 固定 seed + 只改动作描述；帧数宁少勿多（4–8 帧足够） |

**推荐路线**：场景 + 角色立绘用 AI 生成 → 动作表用「AI 出关键帧 + 我们脚本切格/对齐/循环」→ 用
`scripts/build-library-ops-sprites.mjs` 接入。若 AI 动作表质量不达标，退化方案是**单张站立帧 +
程序化呼吸/摆动动画**（渲染器已支持，等距场景就是这么做的）。

---

## 1. 技术规格（实测，务必遵守）

### 1.1 场景

| 项 | 值 | 说明 |
| --- | --- | --- |
| 出图尺寸 | **2752 × 1536**（或等比 1920×1072 / 1376×768） | 渲染器显示按 1920×1072 缩放；非此比例会被 cover 裁切 |
| 逻辑坐标 | 1920 × 1080 | 房间坐标/寻路都基于它，**布局必须对齐** |
| 视角 | **俯视 2.5D**（顶视角，能看到墙面正立面与地板，不是纯平面俯视，也不是 45° 等距） | 参考 `tools/library-ops/layout-guide.png` |
| 描边 | 深色描边（近黑），线宽 2–3px（按 2752 宽计） | 像素画风格 |
| 配色 | 暖木质 + 米纸：木色 `#aa6644 #996633 #995533 #774433`，纸色 `#ddcc99 #ddccaa #ccaa88`，描边/阴影 `#000000` | 实测自上游；换成你自己的色系也行，但要保持**低饱和暖色 + 高对比描边** |
| 禁止 | 文字、水印、角色、UI、强光晕、模糊、抗锯齿渐变 | 有文字会直接穿帮 |
| 输出格式 | PNG（无 alpha）→ 脚本转 WebP | |

### 1.2 家具/装饰层（可选）

- 与场景**同尺寸同构图**，**透明底 PNG**
- 只画家具/装饰（书架、桌椅、盆栽、台灯、地毯、终端、柜台），**不画地面与墙**
- 若不单独出层，直接画进底图也完全可以（当前渲染器支持只有一层底图）

### 1.3 可行走掩码（可选）

- 尺寸同场景；**纯红 `#ee1111` = 可走**，白色 = 障碍
- 不用手绘也可以：`scripts/build-library-ops-scene.mjs` 会按布局（房间矩形 + 走廊）**自动生成**
- 注意：走廊必须涂红，否则角色会被隔断卡住

### 1.4 角色

| 项 | 值 |
| --- | --- |
| 帧尺寸 | **128 × 128**（角色本体约 **80–96px 高**，脚底在帧底约 94% 处，水平居中） |
| 比例 | **chibi / Q 版**，头身比约 1 : 1.2（大头小身），黑描边 |
| 视角 | **正面（facing camera）** 与 **背面** 各一套；侧面可选 |
| 背景 | **纯色品红 `#ff00ff`** 或纯绿 `#00ff00`（便于脚本色键去背景）；**不要投影**，不要地面 |
| 动作清单（建议至少做这 6 个） | `stand_front`（站立/待命）、`walk`（行走循环）、`work`（敲键盘/写字）、`read`（读书）、`sleep`（打瞌睡）、`error`（出错/冒汗） |
| 每个动作帧数 | 4–8 帧（循环）；6 fps 播放 |
| 禁止 | 文字、水印、多角色同框、裁切到画布外、半透明边缘、写实光影 |

---

## 2. 提示词（可直接复制）

### A. 图书馆主场景（英文版，推荐给 MJ / SD / GPT-Image）

```
top-down 2.5D pixel art interior of a cozy library, game room map, 16-bit SNES style,
flat orthographic top-down view slightly showing wall front faces, no perspective distortion,
large reading hall on the left with long wooden tables and bookshelves,
catalog room top-center with card cabinets and shelves,
small code lab room top-right with desks and computer monitors,
archive room on the right with filing cabinets,
server room right-middle with racks,
meeting room bottom-center with a round table,
writing studio bottom-left with desks and papers,
reception desk at the center with a counter,
break room bottom-right with sofa and plants,
warm wood and cream paper palette (#aa6644 #996633 #774433 #ddcc99 #ddccaa),
thick dark outlines, clean pixel edges, crisp 1px lines, no anti-aliasing,
empty rooms, NO characters, NO text, NO UI, NO logos, NO watermark,
flat lighting, no dramatic shadows, no bloom, no blur,
wide top-down game background, 16:9
--ar 16:9 --style raw
```

**中文版**（适合即梦/Seedream/豆包等）：

```
俯视 2.5D 像素画风格的温馨图书馆室内地图，16 位机游戏美术，正交顶视角（略带墙面正立面），
不要透视畸变；左侧是带长木桌与书架的大阅览厅，顶部中间是编目室（卡片柜与书架），
右上角是小型代码实验室（桌子与电脑显示器），右侧是档案室（档案柜），
右中是机房（机架），下方中间是会议厅（圆桌），左下是写作工坊（书桌与纸张），
中央是带柜台的前台，右下是休息区（沙发与绿植）；
暖木色 + 米纸配色（#aa6644 #996633 #774433 #ddcc99 #ddccaa），
粗黑描边，像素边缘干净锐利，无抗锯齿；房间空着，不要角色、不要文字、不要 UI、
不要水印、不要logo、不要光晕模糊；平光，不要夸张阴影；16:9 宽幅游戏背景
```

### B. 家具/装饰层（透明底）

```
pixel art furniture asset sheet on a solid magenta background (#ff00ff),
top-down 2.5D game props, 16-bit style, thick dark outlines, clean pixel edges,
items: wooden bookshelf, long reading table, wooden chair, computer desk with monitor,
filing cabinet, server rack, round meeting table, reception counter, sofa, potted plant,
desk lamp, rug, cardboard boxes, coffee machine,
each item isolated and centered with clear spacing, consistent lighting from top,
NO ground, NO floor, NO walls, NO shadows baked in, NO text, NO watermark,
flat colors, same warm wood and cream palette (#aa6644 #996633 #ddcc99)
--ar 16:9 --style raw
```

> 生成后：`--bg #ff00ff` 用脚本色键去背景，再合成进底图（或直接画进底图省事）。

### C. 角色设计稿（先定形象）

```
character design sheet, chibi pixel art, 16-bit game style, thick dark outline,
a friendly librarian assistant character, big head small body, round friendly face,
warm cream and wood-brown palette with one accent color,
holding a small book, wearing a simple apron, clean flat colors, crisp pixel edges,
front view, back view and 3/4 view side by side on plain magenta background (#ff00ff),
NO text, NO watermark, NO background scenery, NO shadow
--ar 16:9 --style raw
```

**变量表**（每个岗位换一套，产出 N 个不同角色）：

| 岗位 | 角色设定关键词 | 主色 |
| --- | --- | --- |
| 队长 / 调度 | 戴礼帽的猫馆长，拿记事板 | 深蓝 + 金 |
| 研究 / 阅读 | 戴圆眼镜的水豚学者，抱着一摞书 | 米白 + 棕 |
| 编目 / 检索 | 挎着索引卡的仓鼠，背着放大镜 | 浅绿 + 米 |
| 编码 / 实现 | 戴耳机的狐狸程序员，抱笔记本电脑 | 紫 + 深灰 |
| 写作 / 文档 | 拿羽毛笔的小兔作家，头戴贝雷帽 | 橙 + 米 |
| 归档 / 记忆 | 推着小车的乌龟档案员 | 青 + 棕 |
| 运维 / 后台 | 戴工帽的熊技师，拿扳手 | 灰 + 黄 |
| 协作 / 会议 | 抱着文件的浣熊协调员 | 蓝 + 白 |
| 交付 / 汇总 | 抱着一摞包裹的刺猬快递员 | 红 + 米 |
| 待命 / 休息 | 抱着咖啡杯打盹的猫 | 浅灰 + 米 |

### D. 角色动作精灵表（推荐：一个动作一张）

```
pixel art character spritesheet, chibi librarian cat character, walking cycle,
6 frames in a single horizontal row, evenly spaced, same size and same ground line,
frame size 128x128, character about 90px tall, feet on the same baseline,
thick dark outline, flat colors, warm cream and wood-brown palette,
solid magenta background (#ff00ff), NO shadow, NO text, NO watermark,
clean crisp pixels, consistent character design across all frames
--ar 16:9 --style raw
```

> **关键技巧**：
> 1. **固定 seed**（MJ `--seed 12345` / SD 固定种子），只改动作词 → 同一角色不会变形；
> 2. **一个动作一张图**，别指望一张图里 12 个动作都对；
> 3. 帧数写少一点（4–6 帧）模型更容易保持形状；
> 4. 背景一定要纯色，且**不要投影**（投影会被当成角色的一部分）；
> 5. 生成后跑 `build-library-ops-sprites.mjs`，它会去背景 + 切格 + **统一脚底基线**（这一步能救回大量抖动）。

### E. 通用负面提示词

```
text, letters, words, watermark, signature, logo, ui, hud, buttons, speech bubble,
multiple characters, background scenery, floor, ground, shadow, drop shadow,
blurry, soft edges, anti-aliasing, gradient, photorealistic, 3d render, depth of field,
bloom, lens flare, motion blur, cropped, out of frame, extra limbs, deformed
```

中文：`文字、字母、水印、签名、logo、界面、按钮、气泡、多个角色、背景场景、地面、投影、模糊、柔边、抗锯齿、渐变、写实、3D渲染、景深、光晕、裁切、畸形`

### F. 备用：办公室场景（替换 Star-Office-UI 那套）

```
top-down 2.5D pixel art office room, 16-bit style, orthographic top-down view,
desks with monitors, office chairs, meeting table, coffee machine, water cooler,
server rack in a corner, potted plants, whiteboard, filing cabinets,
cool grey and warm wood palette, thick dark outlines, clean pixel edges,
empty room, NO characters, NO text, NO watermark, flat lighting, 16:9
--ar 16:9 --style raw
```

---

## 3. 生成 → 接入 工作流

### 3.1 场景

```bash
# 1) 让模型出 2752×1536（或等比）的图书馆底图，保存为 my-library.png
# 2) 生成参考图（房间/锚点/路网），可作为 img2img / ControlNet 底图
node scripts/export-library-ops-layout-guide.mjs
#    → tools/library-ops/layout-guide.png（透明底）与 layout-guide-solid.png（白底）

# 3) 接入（自动归一尺寸 + 生成可行走掩码 + 校验）
node scripts/build-library-ops-scene.mjs --floor my-library.png
#    也可以只校验： 加 --check
#    也可自带手绘掩码：--mask my-mask.png（红=可走）

# 4) 重新构建即可生效（无需改代码）
npm run build      # 或 npm run dev
```

脚本会输出掩码校验报告：可走比例（建议 25%–60%）、连通块数（必须为 1）、
工作锚点与路网节点是否落在可走区域。**若连通块 > 1，把走廊也涂成红色**。

### 3.2 角色

```bash
# 精灵表模式（一张 6×6 网格图）
node scripts/build-library-ops-sprites.mjs \
  --in capy-walk.png --action walk --variant capy --grid 6x6 --bg "#ff00ff"

# 单帧目录模式（更稳：一个动作的 4–6 张单帧图，按文件名排序）
node scripts/build-library-ops-sprites.mjs \
  --in ./frames/walk --action walk --variant capy --bg auto

# 输出：public/library-ops/claw-library/actors/<variant>/<action>.webp + manifest.json
```

脚本会打印**需要登记到 `src/plugins/library-ops/data/pixel-art.ts` 的那一行**，复制过去即可。

### 3.3 替换许可声明（重要）

全部换成自有素材后：

1. 删除 `public/library-ops/claw-library/`、`public/library-ops/star-office/` 里的第三方文件
   （或保留目录但清空，脚本会写 `GENERATED-BY.md` 占位）；
2. 把 `public/library-ops/*/SOURCE.md` 改成你自己的说明（作者、许可、改动）；
3. 更新根目录 `THIRD_PARTY_NOTICES.md` 与 `docs/ASSET-LICENSES.md`，移除第三方美术条目；
4. 插件设置页「美术资源许可」卡会自动只显示你登记的来源（改 `data/pixel-art.ts` 的 `credit` 字段）。

---

## 4. 验收清单（接入前自查）

**场景**
- [ ] 尺寸 2752×1536（或等比），无文字/水印/角色
- [ ] 12 个房间位置与 `tools/library-ops/layout-guide.png` 大致对齐
- [ ] 视角是俯视 2.5D，不是 45° 等距、不是纯平面
- [ ] 掩码校验：连通块 = 1；工作锚点全部可走
- [ ] 走廊可走（否则角色卡住）

**角色**
- [ ] 帧 128×128，角色本体 80–96px 高，脚底对齐
- [ ] 纯色背景（无投影）
- [ ] 同一动作各帧形象一致（头身比、配色、道具不漂移）
- [ ] 正/背两套（行走时朝向需要）
- [ ] 6 个基础动作齐全（stand_front / walk / work / read / sleep / error）

---

## 5. 如果 AI 出图质量不达标：替代方案

| 方案 | 说明 |
| --- | --- |
| **程序化动画**（零美术依赖） | 只用 1 张站立帧，行走/工作/思考用位移 + 缩放 + 摆动模拟（等距场景已实现）。适合"够用就好" |
| **CC0 素材** | [Kenney](https://kenney.nl/assets)（CC0，但风格偏 16×16 小图，与本项目 Q 版不匹配） |
| **LPC（Liberated Pixel Cup）** | CC-BY-SA 3.0 / GPL，可商用但需署名且**同样有 ShareAlike**；风格是 64×64 俯视 RPG |
| **itch.io 商用授权包** | 例如 LimeZu 的付费 Complete 版：**可商用、可修改、需署名、禁止再分发**（不能提交进公开仓库，但可以随安装包分发？——需按卖家条款确认） |
| **外包/委托画师** | 最省心：把本文第 1 节规格直接发给画师，按 128×128 帧交付 |

> **务实建议**：先用 AI 出**场景**（收益最大、风险最低），角色先用现有的两套 Q 版素材
> （非商业场景下完全够用），等有商用需求时再补角色。

---

## 6. 相关文件

| 文件 | 说明 |
| --- | --- |
| `tools/library-ops/layout-guide.png` | 布局参考图（喂给模型的 img2img/ControlNet 底图） |
| `scripts/export-library-ops-layout-guide.mjs` | 生成上面的参考图 |
| `scripts/build-library-ops-scene.mjs` | 场景接入 + 掩码生成/校验 |
| `scripts/build-library-ops-sprites.mjs` | 角色精灵表接入（去背景/切格/对齐/WebP/清单） |
| `scripts/lib/library-ops-asset-utils.mjs` | 纯函数（颜色/切格/对齐/掩码），有单测覆盖 |
| `src/test/library-ops-asset-tooling.test.ts` | 上述工具的 11 个门禁用例 |
| `src/plugins/library-ops/data/pixel-art.ts` | 资源清单（新增动作/变体登记处） |
| `docs/ASSET-LICENSES.md` | 当前第三方资源许可与义务 |
