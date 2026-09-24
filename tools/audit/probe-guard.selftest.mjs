/**
 * `probe-guard.mjs` 的自证（第 117 轮，O-10）。进 `npm run audit`，作为第 15 道门禁。
 *
 * 每条断言都对着**一次真实事故**或一条**纪律**，不是"跑得通就行"：
 *   PG-1 标题栏的窗口控制必须拒（第 94 轮真的点过「关闭」，关掉了用户的窗口）
 *   PG-2 **面板自己的「关闭」必须放行** —— 反向对照：窗口控制靠上下文判别，不靠文案一刀切
 *   PG-3 破坏性动词必须拒
 *   PG-4 改全局状态的入口必须拒（第 10 轮把执行模式写成了「新工作树」）
 *   PG-5 真提交必须拒
 *   PG-6 普通入口必须放行（否则护栏会把走查全拦死，等于没走查）
 *   PG-7 规则顺序即优先级（窗口控制先于破坏性动词命中）
 *   PG-8 还原是**逆序**执行
 *   PG-9 回调抛错时仍然还原，且错误继续往上抛（不许吞）
 *   PG-10 幂等：第二次 runRestoreAll 不再执行
 *   PG-11 单个还原失败不吞：其它照样还原，失败记进 errors
 *   PG-12 还原之后再登记要报错（说明顺序反了）
 */
import { classifyClick, createProbeGuard, DENY_RULES } from "./probe-guard.mjs";

let pass = 0;
const failures = [];
const check = (id, desc, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${id} ${desc}`);
  } else {
    failures.push(`${id} ${desc}${extra ? ` —— ${extra}` : ""}`);
    console.log(`  ❌ ${id} ${desc}${extra ? ` —— ${extra}` : ""}`);
  }
};
const denies = (c) => classifyClick(c).allow === false;
const allows = (c) => classifyClick(c).allow === true;

console.log("probe-guard 自证：");

// ── 判定规则 ────────────────────────────────────────────────
check("PG-1a", "标题栏「关闭」必须拒", denies({ label: "关闭", inTitlebar: true }));
check("PG-1b", "标题栏「还原」必须拒", denies({ label: "还原", inTitlebar: true }));
check("PG-1c", "标题栏「最小化」/「最大化」必须拒", denies({ label: "最小化", inTitlebar: true }) && denies({ label: "最大化", inTitlebar: true }));
check(
  "PG-1d",
  "窗口控制拒了要能说清为什么（写出第 94 轮那次事故）",
  classifyClick({ label: "关闭", inTitlebar: true }).why.includes("第 94 轮"),
);

check("PG-2a", "面板自己的「关闭」必须放行（反向对照）", allows({ label: "关闭", inTitlebar: false, scope: ".settings-overlay" }));
check("PG-2b", "面板里的「还原」按钮（非窗口）放行", allows({ label: "还原默认缩放", inTitlebar: false, scope: ".ppt-toolbar" }));
check("PG-3a", "「删除项目」必须拒", denies({ label: "删除项目" }));
check("PG-13a", "「运行登录测试」必须拒（第 121 轮实证它写库：建/删一行 accounts）", denies({ label: "运行登录测试" }));
check("PG-13b", "「保存设置」必须拒（写用户设置）", denies({ label: "保存设置" }));
check("PG-13c", "「刷新模型列表」/「导入」/「上传」必须拒", denies({ label: "刷新模型列表" }) && denies({ label: "导入" }) && denies({ label: "上传" }));
check("PG-13d", "拒了要能说清为什么（写出第 121 轮那次实证）", classifyClick({ label: "运行登录测试" }).why.includes("第 121 轮"));
check("PG-13e", "反向对照：只读入口不许被这条规则误伤", allows({ label: "查看登录状态" }) && allows({ label: "模型列表" }) && allows({ label: "设置" }));
check("PG-3b", "「清空对话」必须拒", denies({ label: "清空对话" }));
check("PG-4a", "「切换执行模式」必须拒（第 10 轮事故）", denies({ label: "切换执行模式" }));
check("PG-4b", "「切换主题」必须拒", denies({ label: "切换主题" }));
check("PG-4c", "「新建会话」必须拒", denies({ label: "新建会话" }));
check("PG-5a", "「发送」必须拒", denies({ label: "发送" }));
check("PG-6a", "普通面板入口必须放行", allows({ label: "设置", scope: ".sidebar" }) && allows({ label: "技能", scope: ".sidebar" }));
check("PG-6b", "空白文案也不能无故拒绝", allows({ label: "", scope: ".panel" }));
check("PG-7a", "规则顺序即优先级：标题栏「关闭」命中的是 window-control 而不是别的", classifyClick({ label: "关闭", inTitlebar: true }).rule === "window-control");
check("PG-7b", "规则表非空且 id 唯一", DENY_RULES.length >= 4 && new Set(DENY_RULES.map((r) => r.id)).size === DENY_RULES.length);

// ── 还原纪律 ────────────────────────────────────────────────
{
  const g = createProbeGuard({ name: "PG-8" });
  const order = [];
  g.record("A", () => order.push("A"));
  g.record("B", () => order.push("B"));
  g.record("C", () => order.push("C"));
  await g.runRestoreAll();
  check("PG-8", "还原是逆序执行（C → B → A）", order.join("") === "CBA", `实际 ${order.join("")}`);
}
{
  const g = createProbeGuard({ name: "PG-9" });
  let restored = false;
  g.record("setting", () => {
    restored = true;
  });
  let thrown = null;
  try {
    await g.wrap(async () => {
      throw new Error("探针中途炸了");
    });
  } catch (e) {
    thrown = e;
  }
  check("PG-9", "回调抛错时仍然还原，且错误继续往上抛（不吞）", restored === true && thrown instanceof Error && thrown.message === "探针中途炸了");
}
{
  const g = createProbeGuard({ name: "PG-10" });
  let n = 0;
  g.record("once", () => {
    n += 1;
  });
  await g.runRestoreAll();
  const second = await g.runRestoreAll();
  check("PG-10", "幂等：第二次 runRestoreAll 不再执行（返回 skipped）", n === 1 && second.skipped === true);
}
{
  const g = createProbeGuard({ name: "PG-11" });
  const doneList = [];
  g.record("坏的那个", () => {
    throw new Error("还原失败");
  });
  g.record("好的那个", () => doneList.push("ok"));
  /*
   * 这里**故意**不直接 await：如果实现改成"还原失败就 throw"，
   * 那断言会以"整个脚本崩掉"的形式失败 —— 崩掉的判据比 ❌ 行更难读（变异自证就是这么抓出这一点的）。
   * 所以先接住异常，把它变成一条正常的 ❌。
   */
  let r = null;
  let threw11 = null;
  try {
    r = await g.runRestoreAll();
  } catch (e) {
    threw11 = e;
  }
  check(
    "PG-11",
    "单个还原失败不吞：其它照样还原，失败记进 errors",
    threw11 === null && doneList.length === 1 && r.errors.length === 1 && r.errors[0].what === "坏的那个" && r.restored.length === 1,
    threw11 ? `还原过程直接抛错（等于吞掉了剩下的还原动作）：${threw11.message}` : "",
  );
}
{
  const g = createProbeGuard({ name: "PG-12" });
  g.record("x", () => {});
  await g.runRestoreAll();
  let threw = false;
  try {
    g.record("太晚了", () => {});
  } catch {
    threw = true;
  }
  check("PG-12", "还原之后再登记要报错（顺序反了要说出来）", threw === true);
}

console.log(`\nprobe-guard 自证：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log("❌ 未通过：");
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("✅ 全部通过");
