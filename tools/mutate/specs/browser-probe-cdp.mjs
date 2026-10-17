/**
 * 变异波次：真实渲染探针**从 `--dump-dom` 换成 CDP** 之后，判据还红得动吗？
 *
 * 背景（真机 2026-10-17）：这台 Windows 上无头 Edge 的「一次性输出」全哑
 * （`--dump-dom` / `--screenshot` / `--print-to-pdf` 都是 exit 0、0 字节），
 * 于是 `theme-boot` / `layout-contract` 在**加载期**就抛，18 条判据一条都不跑。
 * 现在改走 CDP 取同一份 `PROBE_JSON`（`src/test/helpers/browser-probe.ts`），
 * 断言与契约一字未改。
 *
 * 这一波要证明两件事，缺一不可：
 *   A. **换传输层没有把判据变软** —— 把"拿回来的数据"弄坏（空对象 / 不导航），两个文件必须红；
 *   B. **判据测的仍然是真渲染** —— 把**被守护的那个 CSS 弄坏**（设置窗 760→160、启动页底色改白），
 *      对应的真渲染判据必须红（这两条正是第 54 / 第 60 波的真实事故签名）。
 * 外加一条反向对照：只改探针的轮询间隔（纯时序，不影响结果）⇒ **必须保持绿**（防止判据对时序过敏）。
 */
export default {
  description:
    "真实渲染探针换传输层（--dump-dom → CDP）之后：坏数据必须红、坏 CSS 必须红、纯时序改动不许红",
  mutations: [
    {
      id: "MUT-1 探针拿回来的数据是空对象（模拟浏览器一次性输出静默为空）",
      why: "THEME-BOOT-7/8 + LAYOUT-0..3：如果传输层坏掉还让用例「绿着过」，等于把判据变哑",
      patches: [
        {
          file: "src/test/helpers/browser-probe.ts",
          from: '  const json = text.slice("PROBE_JSON=".length);',
          to: '    const json = "{}";',
        },
      ],
      tests: ["src/test/theme-boot.test.ts", "src/test/layout-contract.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 不导航（停在 about:blank）",
      why: "THEME-BOOT-7/8 + LAYOUT-0..3：探针等不到 PROBE_JSON 必须抛错让用例红，而不是超时后静默跳过",
      patches: [
        {
          file: "src/test/helpers/browser-probe.ts",
          from: '  await send("Page.navigate", { url });',
          to: "    void url;",
        },
      ],
      tests: ["src/test/theme-boot.test.ts", "src/test/layout-contract.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 设置弹窗宽度塌回 160px（第 54 波事故签名）",
      why: "LAYOUT-1/2：真渲染判据必须仍然抓得住「外壳继承了侧栏宽度」这类合法 CSS 的塌陷",
      patches: [
        {
          file: "src/styles.css",
          from: ".settings-panel,\n.project-manager,\n.config-editor {\nwidth: 760px;",
          to: ".settings-panel,\n.project-manager,\n.config-editor {\nwidth: 160px;",
        },
      ],
      tests: ["src/test/layout-contract.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 启动页底色改成纯白（第 60 波事故签名：启动闪白）",
      why: "THEME-BOOT-7：首帧画布的断言必须仍然由**真渲染**得出，而不是只看静态 CSS 文本",
      patches: [
        {
          file: "src/styles/codem-ui.css",
          from: "  justify-content: center;\n  background: var(--bg-primary);\n  transition: opacity 400ms var(--ease-out);",
          to: "  justify-content: center;\n  background: #ffffff;\n  transition: opacity 400ms var(--ease-out);",
        },
      ],
      tests: ["src/test/theme-boot.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-5（反向对照）只把轮询间隔从 100ms 改成 50ms",
      why: "纯时序改动不许让判据变红 —— 否则说明这些用例对启动快慢过敏（会变成随机红）",
      patches: [
        {
          file: "src/test/helpers/browser-probe.ts",
          from: "    await sleep(100);",
          to: "    await sleep(50);",
        },
      ],
      tests: ["src/test/theme-boot.test.ts"],
      expectRed: false,
    },
  ],
};
