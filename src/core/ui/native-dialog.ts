/**
 * 原生确认框 / 提示框的**统一入口**（第 72 轮真机走查发现的缺陷）
 *
 * ## 真机取证（可复核）
 *
 * 在装机版上读 `window.confirm` 的函数源码，拿到的是：
 *
 * ```js
 * async function(i){return await n("plugin:dialog|confirm",{message:i.toString()})}
 * ```
 *
 * 也就是说：**Tauri 的 dialog 插件把 `window.confirm` 换成了异步插件调用**
 * （`window.alert` 换成 `plugin:dialog|message`）。这带来两个真实后果，
 * 都在装机版上量到过：
 *
 * 1. 🔴 **确认框根本没弹，动作却照做**。`if (!confirm(msg)) return;` 里 `confirm(...)`
 *    返回的是 **Promise**（恒为真值）⇒ `!promise === false` ⇒ **永远继续执行**。
 *    走查实测：点标题栏「切换执行模式」时控制台报
 *    `[Unhandled Rejection] Command plugin:dialog|confirm not allowed by ACL`，
 *    而模式**已经被切过去了** —— 用户既没看到询问，也没机会拒绝。
 *    同形状的站点共 **12 处**（删除项目 / 清除全部恢复数据 / 删除工作树 / 恢复快照 /
 *    回滚文件改动 / 卸载 zvec / 删除智能体 / 删除 Profile / 开启明文密钥库 …），
 *    每一处都是"会改数据"的操作。
 * 2. 🔴 **ACL 没放行 `plugin:dialog|confirm` / `|message`**：`capabilities/default.json`
 *    里写的是 `dialog:default`，而实测它**不含** confirm（同一次点击的报错就是证据），
 *    于是调用被拒 + 一条 unhandled rejection 打到控制台。
 *
 * ## 修法（两件事都做，缺一不可）
 *
 * 1. **权限显式声明**（`capabilities/default.json` 加 `dialog:allow-confirm` /
 *    `dialog:allow-message` / `dialog:allow-ask`）—— 让弹框真的能弹；
 * 2. **调用点统一走本模块** —— 把"Promise 当布尔用"这个坑从**所有**站点上拿掉：
 *    `await confirmDialog(...)` 对"同步布尔"（普通浏览器）与"thenable"（Tauri 注入的 shim）
 *    **两种世界都给对答案**。
 *
 * ## 失败时的取向：**fail-closed**（按「取消」处理），并如实上报
 *
 * 确认框拿不到答案时（没有 `confirm`、Promise 被拒、抛错）**一律返回 false**，
 * 也就是"这次操作不执行"。原因很直接：这些站点的动作都是不可逆的
 * （删数据、覆盖文件、开启明文存储），**"问不到"绝不能等于"用户同意"**。
 * 同时走上报通道，让用户在横幅上看到"操作没有生效"，而不是点了没反应。
 *
 * ⚠️ 与旧行为的差别（如实记下）：`SecretStorageSetting` 原来的写法是
 * "没有 confirm 就当同意"（`typeof window.confirm !== "function" || window.confirm(...)`）。
 * 那是**fail-open**：在拿不到确认框的环境里直接把"明文保存密钥"打开了。现在按 fail-closed
 * 处理 —— 那个开关不会再在"问不到"的情况下被打开（这是有意改的行为，不是回归）。
 */

import { reportActionFailure } from "../storage/persist-failure";

/** 上报用的作用域（与其余 persist-failure 口径一致） */
const AREA_CONFIRM = "ui.confirmDialog";
const AREA_ALERT = "ui.alertDialog";

/**
 * 用户**看得见**的那句后果（走 `options.consequence`）。
 *
 * ⚠️ 为什么必须走这个字段：`reportFailure` 的第三个参数 `extra` **只进控制台**，
 * 不进界面横幅 —— 第一版把"已按取消处理"写在 `extra` 里，用例当场发现
 * `lastMessage` 里根本没有这句话（横幅上用户只会看到"该功能本次没有生效"，
 * 看不出到底是"用户取消"还是"确认框坏了"）。判据是"横幅上写的必须是真实情况"。
 */
const CONSEQUENCE_CONFIRM =
  "确认框不可用（不是「用户点了取消」，而是「根本问不到」）—— 已按取消处理，本次操作没有执行。";

/** 注入点（用例可以传一个假的宿主；生产不传，用全局的 window） */
export interface DialogHost {
  confirm?: (message: string) => unknown;
  alert?: (message: string) => unknown;
}

function defaultHost(): DialogHost {
  const g = globalThis as unknown as DialogHost & { window?: DialogHost };
  // 浏览器/WebView 里 `confirm` 挂在 window 上；Node 测试环境里 happy-dom 也提供
  return (g.window as DialogHost) ?? g;
}

const isThenable = (v: unknown): v is Promise<unknown> =>
  !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

/**
 * 弹出确认框并**等到用户的答案**。
 *
 * - 同步布尔（普通浏览器 / happy-dom）→ 原样返回；
 * - thenable（Tauri dialog 插件注入的 shim）→ await 之后返回；
 * - 抛错 / 被 ACL 拒 / 根本没有 confirm → **false**（按取消处理）+ 上报。
 *
 * 判据写死为 `=== true`：只有明确的 `true` 才算"用户同意"，
 * 别的一律当成"没同意"（`undefined`、异常、被拒、shim 返回非布尔）。
 */
export async function confirmDialog(message: string, host: DialogHost = defaultHost()): Promise<boolean> {
  const fn = host?.confirm;
  if (typeof fn !== "function") {
    reportActionFailure(
      AREA_CONFIRM,
      new Error("当前环境没有 confirm（dialog 插件未注入或不可用）"),
      "确认框不存在",
      { consequence: CONSEQUENCE_CONFIRM },
    );
    return false;
  }
  try {
    const raw = fn.call(host, message);
    const value = isThenable(raw) ? await raw : raw;
    return value === true;
  } catch (e) {
    reportActionFailure(
      AREA_CONFIRM,
      e,
      "确认框调用失败（真机实测形态：`Command plugin:dialog|confirm not allowed by ACL`）",
      { consequence: CONSEQUENCE_CONFIRM },
    );
    return false;
  }
}

/**
 * 弹提示框（`alert` 的替代）。与确认框同源：同样要处理"同步 void"与"thenable"两种世界，
 * 失败时**如实上报**（否则用户看不到提示、控制台却只留一条 unhandled rejection）。
 */
export async function alertDialog(message: string, host: DialogHost = defaultHost()): Promise<void> {
  const fn = host?.alert;
  if (typeof fn !== "function") {
    reportActionFailure(AREA_ALERT, new Error("当前环境没有 alert"), `提示未显示：${message.slice(0, 80)}`, {
      consequence: "这条提示没有弹出来（用户没看到）。",
    });
    return;
  }
  try {
    const raw = fn.call(host, message);
    if (isThenable(raw)) await raw;
  } catch (e) {
    reportActionFailure(
      AREA_ALERT,
      e,
      `提示未显示（真机形态：\`Command plugin:dialog|message not allowed by ACL\`）：${message.slice(0, 80)}`,
      { consequence: "这条提示没有弹出来（用户没看到），横幅上是它的替代说明。" },
    );
  }
}

/** 用例用：这两个 area 的字符串就是判据（不要在两处各写一遍） */
export const DIALOG_FAILURE_AREAS = { confirm: AREA_CONFIRM, alert: AREA_ALERT } as const;
