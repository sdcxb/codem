/**
 * 变异波次：窄容器自适应（`@container`）。
 *
 * 判据 NARROW-1..4 量的是**真渲染**（fixture 加载真实 CSS，在 320/384/480/576/760
 * 五档宽度里量 scrollWidth/clientWidth 与 flex 方向）。这一波证明它们不是恒真：
 * 去掉容器声明或去掉换行规则，窄档必须红。
 */
export default {
  description:
    "工具卡与设置行的窄容器自适应：去掉 .tool-card 的 container-type ⇒ NARROW-1 红；去掉 .settings-content 的 container-type ⇒ NARROW-2/3 红",
  mutations: [
    {
      id: "MUT-1 工具卡不再是容器（退回 @container 无效）",
      why: "NARROW-1：没有容器就没有查询，窄档 IN/OUT 段不会变竖排（标签吃掉正文宽度）",
      patches: [
        {
          file: "src/styles/codem-ui.css",
          from: ".tool-card {\n  container-type: inline-size;\n  container-name: toolcard;\n}",
          to: ".tool-card {\n  /* mutated */\n}",
        },
      ],
      tests: ["src/test/narrow-containers.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 设置内容列不再是容器",
      why: "NARROW-2/3：窄档设置行不换行、输入框被按钮挤扁，容器横向溢出",
      patches: [
        {
          file: "src/styles.css",
          from: "  container-type: inline-size;\n  container-name: settings;",
          to: "  /* mutated */",
        },
      ],
      tests: ["src/test/narrow-containers.test.ts"],
      expectRed: true,
    },
  ],
};
