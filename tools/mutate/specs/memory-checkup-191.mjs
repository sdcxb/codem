/**
 * 第 191 波变异自证：**设置面板 → 记忆体检**的 ctx 接线（GAP-LIST `O-44` / 判据 `MEM-CHECK-5a-行为`、`MEM-CHECK-5a-ctx-props`）。
 *
 * ## 这波要证明什么
 *
 * 原来 `MEM-CHECK-5a` 只是**源码级接线检查**（页签 id / 文案 / 渲染哪个组件）—— 它挡得住改名，
 * 挡不住「**传错值**」。这一波把「把当前项目 + 当前对话传进体检视图」变成行为判据之后，
 * 这里用变异证明那两条行为判据**不是恒真的**：把 ctx 改坏（少传 / 传成别的项目）⇒ 判据必须红。
 *
 * 每条变异都对应一种真实可能被写出来的坏法：
 * - `MUT-1` 传 `undefined`：想省一次 store 读取，于是当前项目在视图里彻底丢失；
 * - `MUT-2` 只漏掉 `sessionId`：项目对了、对话丢了（「半个 ctx」最容易被看漏）；
 * - `MUT-3` 取列表里的另一个项目：把「当前项目」错算成「列表里的某个项目」（语义错但类型对）。
 *
 * 锚点是 `SettingsPanel.tsx` 里**唯一命中**的两行（LF 归一化后匹配；本仓检出是 CRLF）。
 */
export default {
  description:
    "O-44：把「当前项目 + 当前对话」传进记忆体检视图 —— 少传 / 传成别的项目都必须让行为判据变红",
  mutations: [
    {
      id: "MUT-1 体检视图的 projectId 传成 undefined",
      why: "MEM-CHECK-5a-行为 / MEM-CHECK-5a-ctx-props：ctx.projectId 丢了 ⇒ 当前项目的记忆不再显示「生效」，体检会给出与用户实际所在项目不符的结论",
      patches: [
        {
          file: "src/components/SettingsPanel.tsx",
          from: "      projectId={projectIdFromCwd(useProjectStore.getState().currentProject?.path)}",
          to: "      projectId={undefined}",
        },
      ],
      tests: ["src/test/memory-checkup-ctx-behavior.test.tsx", "src/test/memory-checkup-ctx-props.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-2 体检视图的 sessionId 少传（只漏一半 ctx）",
      why: "MEM-CHECK-5a-行为 / MEM-CHECK-5a-ctx-props：项目对了但当前对话丢了 ⇒ 对话级记忆被误判成「不进上下文」",
      patches: [
        {
          file: "src/components/SettingsPanel.tsx",
          from: "      sessionId={useProjectStore.getState().currentSession?.id}",
          to: "      sessionId={undefined}",
        },
      ],
      tests: ["src/test/memory-checkup-ctx-behavior.test.tsx", "src/test/memory-checkup-ctx-props.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-3 体检视图的 projectId 换成列表里另一个项目",
      why: "MEM-CHECK-5a-行为 / MEM-CHECK-5a-ctx-props：类型对、语义错 —— 体检会把「别的项目」的记忆当成当前项目的",
      patches: [
        {
          file: "src/components/SettingsPanel.tsx",
          from: "      projectId={projectIdFromCwd(useProjectStore.getState().currentProject?.path)}",
          to: "      projectId={projectIdFromCwd(useProjectStore.getState().projects[1]?.path)}",
        },
      ],
      tests: ["src/test/memory-checkup-ctx-behavior.test.tsx", "src/test/memory-checkup-ctx-props.test.tsx"],
      expectRed: true,
    },
  ],
};
