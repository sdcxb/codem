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

/**
 * 🔴 **第 84 轮的关键发现：`window.confirm` 在真机上是一条死路**（不是"权限没配"这么简单）。
 *
 * 现场：装机版点「切换执行模式」，控制台报
 * `Command plugin:dialog|confirm not allowed by ACL` —— 而 `capabilities/default.json`
 * 里 `dialog:allow-confirm` **早就加了**（解析出来的能力清单里确实有它，41 条权限之一）。
 *
 * 根因（读依赖源码）：`tauri-plugin-dialog` **2.7.2** 注入的 init 脚本是
 * （`src/init-iife.js`，逐字）：
 *
 * ```js
 * window.alert   = function(i){ n("plugin:dialog|message",{message:i.toString()}) }
 * window.confirm = async function(i){ return await n("plugin:dialog|confirm",{message:i.toString()}) }
 * ```
 *
 * 而**同一个 crate 只注册了 `open` / `save` / `message` 三个命令**（`src/lib.rs` 的
 * `generate_handler![commands::open, commands::save, commands::message]`）——
 * **`plugin:dialog|confirm` 这个命令根本不存在**，所以无论 ACL 怎么配都不会被允许。
 * （`permissions/confirm.toml` 自己写着：`allow-confirm` 是 **DEPRECATED**，
 * "now an alias to `allow-message`"。）
 *
 * ## 所以真机上必须走**插件自己的 JS API**
 *
 * `@tauri-apps/plugin-dialog` 的 `confirm()` 实现是
 * `messageCommand(msg, { buttons: 'OkCancel' }) === 'Ok'` —— 它打的是**已注册**的
 * `plugin:dialog|message`。这才是被支持的路径。
 *
 * 本模块因此按这个优先级取答案（`confirmDialog`）：
 * 1. **插件 JS API**（真机；`host.pluginConfirm` 可注入，便于用例）；
 * 2. `window.confirm`（普通浏览器、happy-dom 等**同步布尔**环境）；
 * 3. 都没有 ⇒ fail-closed + 上报。
 *
 * 反过来说：v1.16.125 那次改动让"问不到"变成了"安全地拒绝"（不再无声地照做），
 * 但**弹框本身一直弹不出来** —— 这一轮才真正修好。GAP-LIST 的 O-3 据此更新。
 */
export interface DialogHost {
  confirm?: (message: string) => unknown;
  alert?: (message: string) => unknown;
  /** 插件 JS API（真机路径）。返回布尔；抛错即视为"问不到"。 */
  pluginConfirm?: (message: string, opts: { okLabel: string; cancelLabel: string }) => Promise<boolean>;
  /** 插件 JS API 的提示框（真机路径）。 */
  pluginMessage?: (message: string) => Promise<unknown>;
}

function defaultHost(): DialogHost {
  const g = globalThis as unknown as DialogHost & { window?: DialogHost };
  // 浏览器/WebView 里 `confirm` 挂在 window 上；Node 测试环境里 happy-dom 也提供
  return (g.window as DialogHost) ?? g;
}

/** 真机判据：Tauri 运行时在（`window.__TAURI__` 或 `__TAURI_INTERNALS__` 由插件注入） */
function isTauriRuntime(): boolean {
  const g = globalThis as unknown as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown; window?: { __TAURI__?: unknown } };
  return !!g.__TAURI__ || !!g.__TAURI_INTERNALS__ || !!g.window?.__TAURI__;
}

const isThenable = (v: unknown): v is Promise<unknown> =>
  !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

/**
 * 走**插件 JS API** 弹确认框（真机唯一可行的路径）。
 *
 * `host.pluginConfirm` 是给用例注入的；生产不传时动态 import 插件，
 * 这样浏览器构建里也不会把插件打进步 bundle（只有在真机上才会走到这里）。
 */
async function pluginConfirm(
  message: string,
  host: DialogHost,
): Promise<{ ok: true; value: boolean } | { ok: false; error: unknown }> {
  try {
    const fn =
      host.pluginConfirm ??
      (async (m: string, o: { okLabel: string; cancelLabel: string }) => {
        const mod = await import("@tauri-apps/plugin-dialog");
        return mod.confirm(m, { kind: "warning", okLabel: o.okLabel, cancelLabel: o.cancelLabel });
      });
    const value = await fn(message, { okLabel: "确定", cancelLabel: "取消" });
    return { ok: true, value: value === true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * 弹出确认框并**等到用户的答案**。
 *
 * 优先级见上面的长注释：**真机走插件 JS API**（`plugin:dialog|message` 的 OkCancel），
 * 普通浏览器走 `window.confirm` 的同步布尔，两者都拿不到 ⇒ **false**（按取消处理）+ 上报。
 *
 * 判据写死为 `=== true`：只有明确的 `true` 才算"用户同意"，
 * 别的一律当成"没同意"（`undefined`、异常、被拒、返回非布尔）。
 */
export async function confirmDialog(message: string, host: DialogHost = defaultHost()): Promise<boolean> {
  /*
   * ① 真机（或用例注入了 pluginConfirm）：走插件 JS API。
   *
   * ⚠️ 失败**不立刻放弃**：留到 ② 再试一次同步路径，最后才上报。
   * 这样"插件路径不可用但环境里有可用的 confirm"（很多组件用例就是这种形态）仍然能问出来；
   * 而真机上两条路都不可用 ⇒ 走 fail-closed + 上报（与 v1.16.125 的安全取向一致）。
   */
  let pluginError: unknown = null;
  if (typeof host?.pluginConfirm === "function" || isTauriRuntime()) {
    const r = await pluginConfirm(message, host);
    if (r.ok) return r.value;
    pluginError = r.error;
  }

  // ② 普通浏览器 / happy-dom：同步布尔（或 thenable）
  const fn = host?.confirm;
  if (typeof fn !== "function") {
    reportActionFailure(
      AREA_CONFIRM,
      pluginError ?? new Error("当前环境没有 confirm（dialog 插件未注入或不可用）"),
      pluginError ? "确认框调用失败（插件 JS API 路径，且环境里没有可用的 confirm）" : "确认框不存在",
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
      pluginError
        ? "确认框调用失败（插件 JS API 与注入的 confirm 都不行 —— 真机形态：`Command plugin:dialog|confirm not allowed by ACL`）"
        : "确认框调用失败（真机实测形态：`Command plugin:dialog|confirm not allowed by ACL`）",
      { consequence: CONSEQUENCE_CONFIRM },
    );
    return false;
  }
}

/**
 * 弹提示框（`alert` 的替代）。
 *
 * 与确认框同一个优先级：**真机走插件的 JS API**（`message()` → 已注册的 `plugin:dialog|message`），
 * 普通浏览器走 `window.alert`（同步 void）。失败时**如实上报**
 * （否则用户看不到提示、控制台却只留一条 unhandled rejection）。
 *
 * 注：`window.alert` 的注入 shim 打的是 `plugin:dialog|message`（**存在**的命令），
 * 所以真机上它本来是能用的；走 JS API 是为了统一（可设 kind/title），并避免依赖注入 shim。
 */
export async function alertDialog(message: string, host: DialogHost = defaultHost()): Promise<void> {
  if (typeof host?.pluginMessage === "function" || isTauriRuntime()) {
    try {
      const fn =
        host.pluginMessage ??
        (async (m: string) => {
          const mod = await import("@tauri-apps/plugin-dialog");
          return mod.message(m, { kind: "info" });
        });
      await fn(message);
      return;
    } catch (e) {
      reportActionFailure(AREA_ALERT, e, `提示未显示（插件 JS API 路径）：${message.slice(0, 80)}`, {
        consequence: "这条提示没有弹出来（用户没看到），横幅上是它的替代说明。",
      });
      return;
    }
  }

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
