/**
 * 走查/探针**安全护栏**（第 117 轮，O-10 的标准化落地）。
 *
 * ## 为什么要有这个文件
 *
 * 这类事故在本项目**真实发生过三次**，而且每次都是"探针把用户的东西改了"：
 *
 * | 轮次 | 事故 | 后果 |
 * | --- | --- | --- |
 * | 第 10 轮 | 探针点「切换执行模式」 | 把用户项目的执行模式从「本地处理」改成「新工作树」（写进了设置） |
 * | 第 94 轮 | 排除名单写的是 `最小化\|最大化\|关闭窗口\|关闭应用`，而标题栏那两个按钮的**实际文案**是「还原」「关闭」 | 走查**真的点了窗口控制**：点「关闭」就是关掉用户的窗口（同时还污染了读数） |
 * | 第 93 轮 | 笔记本工作区浮层盖住整个界面，而复位脚本只认 `.settings-overlay`/`.modal-overlay` | 点击全被画布吃掉 ⇒ 量出来的是**假缺陷**（"项目管理器打不开"） |
 *
 * 三件事的共性：**探针点之前不知道自己会改什么，改完也没还回去。**
 * 所以这里把两条纪律做成代码，谁都能复用（走查脚本、一次性探针、变异脚本）：
 *
 * 1. `classifyClick(control)` —— **点之前先判**：窗口控制 / 破坏性动词 / 改全局状态 / 真提交，
 *    默认**拒绝**，并且带上"为什么"（写出历史事故，不是凭感觉）。
 *    注意：面板/浮层自己的「关闭」是**允许**的 —— 走查本来就要开关面板，
 *    所以窗口控制靠 `inTitlebar` 这个**上下文**判别，而不是靠文案一刀切（这正是第 94 轮踩的坑）。
 * 2. `createProbeGuard()` —— **改之前先登记怎么还**：`record(说明, 还原函数)`，
 *    结束时（正常返回、抛错、被中断都一样）**逆序**执行；幂等（第二次调用不再重复还原）。
 *
 * 这两条正是 GAP-LIST 的 O-10 里挂着的待办。
 */

/** 判定规则：从上到下**第一条命中**的生效（顺序即优先级，改顺序要重跑自证）。 */
export const DENY_RULES = [
  {
    id: "window-control",
    why: "第 94 轮事故：走查真的点了标题栏的窗口控制（点「关闭」= 关掉用户的窗口，点「还原/最大化」= 改窗口布局）",
    test: (c) =>
      c.inTitlebar === true &&
      /^(还原|还原窗口|关闭|关闭窗口|关闭应用|最小化|最大化|Restore( window)?|Minimize|Maximize|Close( window)?)$/i.test(
        String(c.label ?? "").trim(),
      ),
  },
  {
    id: "data-write",
    /*
     * 第 121 轮的**实证事故**：走查点了设置里的「运行登录测试」——
     * 它建了一行 `accounts`（`test-1790281722602`）又删掉，只在控制台留下一行
     * `[WriteAudit] crud.delete table=accounts`（第 118 轮走查读数里唯一的 warning，已核实）。
     * 当时护栏**没拦住**：它的文案里没有"删除/清空"这类破坏性动词。
     * ⇒ 补这一类：**会写用户数据的入口**。
     * 同时配了**结果侧**判据 `tools/audit/fingerprint-userdata.mjs`（走查前后比主库/WAL 的 sha256）——
     * 名单不可能穷尽，**想到的写入口靠名单，没想到的靠指纹**。
     */
    why: "会写用户数据（第 121 轮实证：点「运行登录测试」建/删了一行 accounts；走查前后请再用 fingerprint-userdata 比对指纹）",
    test: (c) => /运行登录测试|登录测试|测试连接|保存设置|保存并刷新|添加模型|刷新模型列表|导入|导出|上传|同步|清空缓存|重建索引/i.test(String(c.label ?? "")),
  },
  {
    id: "destructive",
    why: "破坏性动作（删除/清空/重置/卸载/停止/回滚）会改用户数据，走查不许碰",
    test: (c) => /删除|移除|清空|重置|回退|回滚|卸载|停止|取消委派|恢复默认|Delete|Remove|Clear|Reset|Rollback|Uninstall|Stop/i.test(String(c.label ?? "")),
  },
  {
    id: "global-state",
    why: "第 10 轮事故：点「切换执行模式」把用户项目的执行模式写成了「新工作树」；这类入口会改全局/窗口状态",
    test: (c) =>
      /切换终端|切换主题|切换执行模式|切换语言|退出|登出|注销|Quit|Sign out|Log out|New chat|New session|新对话|新建会话/i.test(String(c.label ?? "")),
  },
  {
    id: "submit",
    why: "真提交（发送/提交）会真的发起动作，不是「看看界面」",
    test: (c) => /^(发送|提交|Send|Submit)$/i.test(String(c.label ?? "").trim()),
  },
];

/**
 * 判一个控件能不能点。
 * @param {{label?: string, inTitlebar?: boolean, scope?: string}} control
 * @returns {{allow: boolean, rule: string, why: string}}
 */
export function classifyClick(control = {}) {
  const label = String(control.label ?? "");
  for (const rule of DENY_RULES) {
    if (rule.test({ ...control, label })) return { allow: false, rule: rule.id, why: rule.why };
  }
  return {
    allow: true,
    rule: "none",
    why: control.inTitlebar === true ? "标题栏里的非窗口控制（允许）" : `面板/浮层内的入口（允许；scope=${control.scope ?? "panel"}）`,
  };
}

/**
 * 探针护栏：**改之前登记怎么还**。
 * - `record(what, fn)`：登记一个还原动作（后登记的**先**还原）
 * - `runRestoreAll()`：逆序执行，幂等；单个还原失败**不吞**，收集进 `errors` 继续还剩下的
 * - `wrap(fn)`：正常返回、抛错、都保证还原（抛错照样往上抛）
 */
export function createProbeGuard({ name = "probe" } = {}) {
  const restores = [];
  let done = false;
  const log = [];

  return {
    name,
    get pending() {
      return restores.length;
    },
    get restored() {
      return done;
    },
    record(what, fn) {
      if (typeof fn !== "function") throw new Error(`record(${what}) 的还原动作必须是函数`);
      if (done) throw new Error(`已经在 ${name} 里还原过了，不能再登记「${what}」（顺序反了：登记要在还原之前）`);
      restores.push({ what, fn });
      log.push(`record: ${what}`);
      return this;
    },
    async runRestoreAll() {
      if (done) return { skipped: true, restored: [], errors: [] };
      done = true;
      const errors = [];
      const restored = [];
      for (const item of [...restores].reverse()) {
        try {
          await item.fn();
          restored.push(item.what);
          log.push(`restored: ${item.what}`);
        } catch (e) {
          errors.push({ what: item.what, error: String(e && e.message ? e.message : e) });
          log.push(`restore FAILED: ${item.what}`);
        }
      }
      return { skipped: false, restored, errors };
    },
    async wrap(fn) {
      try {
        return await fn();
      } finally {
        await this.runRestoreAll();
      }
    },
    history() {
      return [...log];
    },
  };
}
