/**
 * 变异波次：UI 工艺 P2 七项（边缘渐隐 / Diff 双视图 / 共享元素转场 / 文档令牌 /
 * 组件目录 / roving focus / 合成提示音 / 动效棘轮）。
 *
 * 每条变异对应一组判据；锚点都是**唯一串**，改坏必须变红。
 */
export default {
  description:
    "UI 工艺 P2：EDGEFADE（触边归零）/ DIFFVIEW（分屏行配对）/ VIEWTRANS（转场降级）/ UIDOC（文档令牌与组件目录）/ ROVING（RTL 镜像）/ SOUND（默认关）/ MOTION（裸曲线棘轮）。8 条变异各自对红",
  mutations: [
    {
      id: "MUT-1 边缘渐隐不再判断触顶",
      why: "EDGEFADE-3：触顶时上侧仍然渐隐 ⇒ 首行被淡化成灰字",
      patches: [
        {
          file: "src/core/ui/edge-fade.ts",
          from: "  if (state.atTop) {\n    stops.push(\"rgba(0,0,0,1) 0px\");\n  } else {",
          to: "  if (false) {\n    stops.push(\"rgba(0,0,0,1) 0px\");\n  } else {",
        },
      ],
      tests: ["src/test/edge-fade.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 分屏不再配对删除/新增（各自单独成行）",
      why: "DIFFVIEW-3：同一处修改被拆成两行、左右不共享行号 ⇒ 分屏失去对齐语义",
      patches: [
        {
          file: "src/core/ui/diff-view.ts",
          from: "    const pairs = Math.max(dels.length, adds.length);",
          to: "    const pairs = dels.length + adds.length;",
        },
        {
          file: "src/core/ui/diff-view.ts",
          from: "      const del = dels[k];\n      const add = adds[k];",
          to: "      const del = dels[Math.min(k, dels.length - 1)];\n      const add = adds[Math.min(k, adds.length - 1)];",
        },
      ],
      tests: ["src/test/diff-view.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-3 共享元素转场退化为普通更新",
      why: "VIEWTRANS-2：支持 View Transitions 时也不再走转场（缩略图不会长成大图）",
      patches: [
        {
          file: "src/core/ui/view-transition.ts",
          from: "  if (typeof d?.startViewTransition === \"function\") {",
          to: "  if (false) {",
        },
      ],
      tests: ["src/test/view-transition.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 文档引用一个不存在的令牌",
      why: "UIDOC-1：文档与实现脱节（读者照着写会得到失效声明）",
      patches: [
        {
          file: "docs/ui-spec.md",
          from: "`--space-9`",
          to: "`--space-99`",
        },
      ],
      tests: ["src/test/ui-doc-tokens.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-5 组件目录写一个不存在的类",
      why: "UIDOC-2：目录看着像真的、类名早已改名",
      patches: [
        {
          file: "docs/component-gallery.html",
          from: "class=\"midturn-guidance-header\"",
          to: "class=\"midturn-guidance-header-renamed\"",
        },
      ],
      tests: ["src/test/ui-doc-tokens.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-6 roving focus 去掉 RTL 镜像",
      why: "ROVING-2：RTL 下左右箭头方向反了（键盘用户在阿拉伯语界面会迷路）",
      patches: [
        {
          file: "src/core/ui/roving-focus.ts",
          from: "    delta = (forward ? 1 : -1) * (rtl ? -1 : 1);",
          to: "    delta = forward ? 1 : -1;",
        },
      ],
      tests: ["src/test/roving-focus.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-7 提示音默认打开",
      why: "SOUND-1：打扰性能力默认必须关",
      patches: [
        {
          file: "src/core/ui/sound-cues.ts",
          from: "    return getSetting(SOUND_CUES_SETTING_KEY) === \"1\";",
          to: "    return getSetting(SOUND_CUES_SETTING_KEY) !== \"0\";",
        },
      ],
      tests: ["src/test/sound-cues.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-8 在规则里写裸 cubic-bezier",
      why: "MOTION-1：动效曲线绕过令牌（同类交互手感开始漂移）",
      patches: [
        {
          file: "src/styles/codem-ui.css",
          from: ".diff-view-mode-btn.is-active {",
          to: ".diff-view-mode-btn.is-active { transition-timing-function: cubic-bezier(0.1, 0.2, 0.3, 0.4);",
        },
      ],
      tests: ["src/test/motion-tokens.test.ts"],
      expectRed: true,
    },
  ],
};
