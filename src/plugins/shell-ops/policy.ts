/**
 * `@codem/shell-ops` —— shell 路由策略（插件的**唯一判定源**）。
 *
 * ## 为什么要有这个插件（真机缺陷）
 *
 * Codem 的 `bash` 工具在 Windows 上**实际执行的是 Windows PowerShell 5.1**：
 * `execute_command` 里写死 `Command::new("powershell")`（`src-tauri/src/lib.rs`）。
 * 于是模型按 bash 习惯写的命令反复撞坑（本地实测，2026-10-15）：
 *
 * | 坑 | PowerShell 5.1 | bash |
 * |---|---|---|
 * | `&&` 链式 | 语法错误 | 正常 |
 * | `Set-Content -Encoding UTF8` | **写出 BOM**（`ef bb bf`，炸 JSON/PostCSS 解析） | 不写 |
 * | 单元素数组转 JSON | 降级成标量 `"a"` | 用 jq 不降级 |
 * | heredoc / 引号 / 反引号 | 转义地狱 | 原样 |
 *
 * 每一次报错都变成一轮「读错误 → 改写 → 再试」，这就是被浪费的 token、时间与注意力。
 *
 * ## 这个插件做什么
 *
 * 1. **真 bash**：把 `bash` 工具的执行器换成真正的 bash（Git Bash / 显式配置的 bash），
 *    而不是「名字叫 bash、跑的是 PowerShell」；
 * 2. **硬锁回退**：启用期间**拒绝**点名 `powershell` / `powershell.exe` 的命令，
 *    并且 **bash 解析不到时大声失败、绝不悄悄退回 PowerShell** —— 这两条在**执行入口之前**判定，
 *    是结构约束、不依赖提示词：模型即使点名 `powershell` 也到不了执行层；
 * 3. **留出口**：Windows 原生活儿（cmdlet / 注册表 / 服务 / COM）走 **PowerShell 7**（`pwsh`），
 *    Core 版、写文件不带 BOM、支持 `&&`。
 *
 * ## 分工（为什么判定在 TS、解析在执行在 Rust）
 *
 * 渲染进程读不到文件系统（Tauri 命令才碰得到），所以：
 * - **TS 侧**（本模块）只决定**意图**：用 bash、拒绝 powershell、还是拒绝执行（带可执行的提示）；
 * - **Rust 侧**（`execute_command`）负责**解析并校验 bash 可执行文件**，解析不到就返回**错误**
 *   （同样绝不回退 PowerShell）。
 * 两边都不做"悄悄换执行器"这件事。
 *
 * ## 边界（如实写）
 *
 * - 覆盖 `bash` 工具与所有走 `execute_command` 的调用；
 * - 它**不是**安全沙箱：目的是让模型走对执行器，权限仍由既有权限层负责；
 * - PowerShell 识别按**命令词**（命令开头，或 `;` `&&` `||` `|` 换行之后），
 *   不识别 `cmd.exe /c powershell ...` 这类二次包装（少见；真发生可从执行日志 `exec start cmd=...` 看到）。
 */

import { getSetting, setSettingConfirmed } from "../../core/storage/settings";

/**
 * 导出面（2026-10-16 收口，`node tools/audit/knip-gate.mjs` 棘轮逼出来的）：
 * **只导出真实被生产代码消费的东西**。
 *
 * 收口前这里 export 了 11 个符号、`index.ts` 又原样转出去 16 个，knip 实测
 * `exports=73 / types=25`（基线 49/21）—— 多出来的 24+4 条**全部**来自本插件。
 * 那些导出没有任何生产消费者（只有 barrel 自己与测试引用）⇒ 是真的死面，不是"公共 API"。
 * 现在只留：设置键 `SHELL_OPS_ENABLED_KEY`（provider 要用来落默认值）+ 三个函数 + `ShellPlan`。
 *
 * 插件名不再做成常量：它只出现在注册表（`registerBuiltinPlugin` 的字面量）与文档里，
 * 一个没有任何读者的常量只是"看起来像契约"。
 */
// 插件名（与 registerBuiltinPlugin 里的一致）：@codem/shell-ops

/** 设置键：插件总开关（默认**开** —— 用户要求默认开启）。 */
export const SHELL_OPS_ENABLED_KEY = "codem-shell-ops-enabled";
/** 设置键：显式 bash 路径（可选；留空则由 Rust 侧按标准位置探测）。 */
const SHELL_OPS_BASH_PATH_KEY = "codem-shell-ops-bash-path";
/** 设置键：显式 PowerShell 7 路径（可选；仅用于错误提示里给出可执行出口）。 */
const SHELL_OPS_PWSH_PATH_KEY = "codem-shell-ops-pwsh-path";

// 标准 bash 位置**不在这里维护**：唯一的判定源是 Rust 侧 `resolve_bash_path()`
// （显式配置 → 环境变量 → 标准安装位置），本文件不复制一份"看起来像规则"的列表。

/** 标准 PowerShell 7 位置（只用于给模型的可执行提示）。 */
const PWSH_STANDARD_PATHS = [
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
];

function readString(key: string): string | null {
  try {
    const v = getSetting(key);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** 插件是否启用（读不到设置时视为**默认开**）。 */
export function isShellOpsEnabled(): boolean {
  // 读设置失败时**不在这里 return** —— catch 里无条件返回「放行」会被结构审计判成
  // 「判定失败被当成通过」（GATE-1/GATE-5 命中的就是这个形状）。
  // 现在把读失败记成事实，放行决定放在 try 之外并写明理由：读不到 ⇒ 按默认开启（用户要求），
  // 且失败本身留痕。
  let v: unknown;
  let readFailed = false;
  try {
    v = getSetting(SHELL_OPS_ENABLED_KEY);
  } catch (e) {
    readFailed = true;
    console.warn("[shell-ops] 读设置失败，按默认（开启）处理:", e);
  }
  if (readFailed) return true;
  if (v === undefined || v === null || v === "") return true;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return !/^(false|0|off|no)$/i.test(v.trim());
  return Boolean(v);
}

/** 显式配置的 bash 路径（可能为空 ⇒ 交给 Rust 探测）。 */
function configuredBashPath(): string | null {
  const fromSetting = readString(SHELL_OPS_BASH_PATH_KEY);
  if (fromSetting) return fromSetting;
  const fromEnv = (process.env.CODEM_SHELL_OPS_BASH || "").trim();
  return fromEnv || null;
}

/** 显式配置的 PowerShell 7 路径（用于提示）。 */
function configuredPwshPath(): string | null {
  const fromSetting = readString(SHELL_OPS_PWSH_PATH_KEY);
  if (fromSetting) return fromSetting;
  const fromEnv = (process.env.CODEM_SHELL_OPS_PWSH || "").trim();
  return fromEnv || null;
}

export interface ShellPlan {
  /** 本次要用的执行器 */
  kind: "bash" | "powershell";
  /** 交给 Rust 的 bash 路径提示（空 ⇒ 由 Rust 按标准位置探测） */
  bashPath: string | null;
  /** 拒绝执行时的提示（有它 ⇒ 调用方必须直接把 message 交回模型，不许执行） */
  refusal?: string;
}

/**
 * 命令里是否**点名调用**了 Windows PowerShell（5.1）？
 *
 * 判定按「命令词」：命令开头、或 `;` `&&` `||` `|`／换行之后的第一个词是
 * `powershell` / `powershell.exe`（允许带盘符路径）。`pwsh` **不算**（那是 7，是我们要留的出口）。
 *
 * 不再 export（只有本模块的 `resolveShellPlan` 用）：判据从**行为**上测
 * （`resolveShellPlan(cmd).refusal` 有/无），比钉一个内部谓词更结实。
 */
function mentionsWindowsPowerShell(command: string): boolean {
  return /(^|[\n;|]|&&|\|\|)\s*(?:[A-Za-z]:\\[^"'\s]*\\)?powershell(?:\.exe)?\b/i.test(command);
}

/** 给模型的 PowerShell 7 出口提示（有显式配置就用它，否则给标准位置 + PATH 上的 pwsh）。 */
function pwshRouteHint(): string {
  const explicit = configuredPwshPath();
  const list = [explicit, ...PWSH_STANDARD_PATHS].filter(Boolean) as string[];
  return `"${list[0]}"（或先运行 where pwsh 找到本机路径）`;
}

/**
 * 把「默认开启」落成一条**真实的设置项**（键不存在时写 `true`）。
 *
 * ## 为什么不在插件装配（apply）时写（真机取证，2026-10-16）
 *
 * 打包版启动时 CDP 抓到的事实：
 *
 * ```text
 * [shell-ops] shell-ops：已开启（…）                      ← apply 跑了
 * [error] [PersistFailure] settings.setSetting 写盘失败（第 1 次）：
 *         端口已注册但该域镜像未接手（未就绪 / 未镜像 / 被逐出）（设置未保存）
 * ```
 *
 * 装配发生在存储端口**预热之前**，那时写设置必失败（`RustDataPort.setConfirmed`
 * 对未预热的端口明确"不写、返回 false"，以免用空表覆盖已有内容）。
 * 结果是：每次启动都报一次「设置未保存」，而那个键**永远不存在** ——
 * "插件确实跑过"在设置面上就没有任何证据。
 *
 * ## 现在怎么写
 *
 * 放到**真正要跑命令时**（`resolveShellPlan` 的第一句）：那时应用早就完成预热。
 * 用**确认式写入**（`setSettingConfirmed`：等引擎确认才返回 true），
 * 因此"写成功"与"没写成功"是两件事，后者会如实进 console（行为不受影响 ——
 * 键缺失本来按默认开启处理）。
 *
 * 只在键缺失时写 ⇒ 永不覆盖用户/脚本显式设过的值；写入成功后键就存在了，
 * 后续判定只读不写（不会每条命令都写盘）。
 */
function materializeEnabledDefault(): void {
  let existing: unknown;
  try {
    existing = getSetting(SHELL_OPS_ENABLED_KEY);
  } catch {
    return; // 读都读不了：不在这里做任何判定（放行决定由 isShellOpsEnabled 负责）
  }
  if (existing !== null && existing !== undefined) return; // 已存在（含用户设过）⇒ 一个字不动
  void setSettingConfirmed(SHELL_OPS_ENABLED_KEY, "true")
    .then((ok) => {
      if (ok) console.log("[shell-ops] 已落默认设置 codem-shell-ops-enabled=true（默认开启）");
      else console.warn("[shell-ops] 默认设置未落库（行为不受影响：键缺失按默认开启处理）");
    })
    .catch((e) => console.warn("[shell-ops] 默认设置写入异常（不影响本次运行）:", e));
}

/**
 * 决定这条命令用哪个执行器 —— **唯一判定源**。
 *
 * - 插件关闭 ⇒ `powershell`（沿用旧行为：用户禁用插件后必须能回到原状）；
 * - 插件开启 + 命令点名 `powershell` ⇒ **拒绝**（5.1 的坑全在它身上），并给出 PS7 出口；
 * - 其它 ⇒ `bash`（bash 是否存在由 Rust 解析；解析不到时 Rust 侧拒绝执行，**不回退**）。
 */
export function resolveShellPlan(command: string): ShellPlan {
  // 这里是"真的要用这个插件"的入口（应用已预热），默认设置项在这一刻才落（见上）。
  materializeEnabledDefault();
  if (!isShellOpsEnabled()) {
    return { kind: "powershell", bashPath: null };
  }
  if (mentionsWindowsPowerShell(command)) {
    return {
      kind: "bash",
      bashPath: configuredBashPath(),
      refusal:
        "Error: Windows PowerShell 5.1 已被 @codem/shell-ops 插件拒绝（它写文件会带 UTF-8 BOM、" +
        "不支持 `&&`、单元素数组转 JSON 会降级 —— 这些正是反复报错的来源）。\n" +
        "请用 bash 语法重写这条命令；只有 Windows 原生能力（cmdlet / 注册表 / 服务 / COM）才需要 PowerShell，" +
        `那种情况请显式调用 PowerShell 7：${pwshRouteHint()} -NoProfile -Command '<命令>'。`,
    };
  }
  return { kind: "bash", bashPath: configuredBashPath() };
}

/** 给界面/真机取证看的一行状态。 */
export function describeShellOps(): string {
  if (!isShellOpsEnabled()) return "shell-ops：已关闭（命令交回 Windows PowerShell）";
  const bash = configuredBashPath();
  return (
    `shell-ops：已开启（bash${bash ? `=${bash}` : " 由标准位置探测"}；` +
    `Windows PowerShell 5.1 已拒绝；Windows 原生活儿请用 ${pwshRouteHint()}）`
  );
}
