# 变异自证（`tools/mutate/`）

本目录把「变异不做等于没测」变成**仓库里可复核的产物**（GAP-LIST 的 `O-53` / 判据 `MUTATE-ARTIFACT-1`）。

## 规矩

1. **每新增一条判据**，都要有对应的变异：把实现改坏 ⇒ 该判据**变红** ⇒ 原样还原。
   改坏了还是绿的判据 = 恒真判据 = 没在测那件事。
2. **规格进 `specs/<wave>.mjs`、结果进 `results/<wave>.json`，两者都提交**（不许只在报告里写）。
3. 波次必须登记进 `registry.json`，否则闸门不会看它。
4. 跑法：

```powershell
node tools/mutate/run.mjs --list              # 看有哪些波次
node tools/mutate/run.mjs memory-budget-191   # 跑一个波次（会把结果写进 results/）
node tools/mutate/check-artifacts.mjs         # 闸门（npm run audit:mutations）
```

## 规格文件长什么样

```js
export default {
  description: "一句话说明这一波变异自证的是哪批判据",
  mutations: [
    {
      id: "MUT-1 去掉字节预算",
      why: "MEM-BYTES-1：没有预算时超限语料不会被上报",
      // 锚点必须是**唯一命中**的一段原文（在 LF 归一化后匹配；本仓检出是 CRLF，运行器会还原行尾）
      patches: [{ file: "src/core/memory/memory.ts", from: "  const x = 1;", to: "  const x = 2;" }],
      tests: ["src/test/memory-byte-budget.test.ts"],
      expectRed: true, // 反向对照（「改坏了也不许红」）用 expectRed: false
    },
  ],
};
```

## 闸门（`MUTATE-ARTIFACT-1`）查五件事

1. 登记波次有结果文件；
2. `restored === true`（源码逐字节还原 + 复原后判据全绿）；
3. 每条变异 `ok === true`；
4. 规格指纹与结果一致（规格改过 ⇒ 旧结果作废）；
5. 锚点在当前源码里仍**唯一命中**（代码改了 ⇒ 必须重跑，不许拿过期结果交差）。

第 5 条是刻意的：它让「上次的绿」不能自动延伸到「这次改过的代码」。
