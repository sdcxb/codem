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

import { getSetting } from "../../core/storage/settings";

/** 插件名（与 `registerBuiltinPlugin` 一致，插件管理器按它启停）。 */
export const SHELL_OPS_PLUGIN_NAME = "@codem/shell-ops";

/** 设置键：插件总开关（默认**开** —— 用户要求默认开启）。 */
export const SHELL_OPS_ENABLED_KEY = "codem-shell-ops-enabled";
/** 设置键：显式 bash 路径（可选；留空则由 Rust 侧按标准位置探测）。 */
export const SHELL_OPS_BASH_PATH_KEY = "codem-shell-ops-bash-path";
/** 设置键：显式 PowerShell 7 路径（可选；仅用于错误提示里给出可执行出口）。 */
export const SHELL_OPS_PWSH_PATH_KEY = "codem-shell-ops-pwsh-path";

/** 标准 bash 位置（Rust 侧同一份顺序；这里只用于提示与面板显示）。 */
export const BASH_STANDARD_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

/** 标准 PowerShell 7 位置。 */
export const PWSH_STANDARD_PATHS = [
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
export function configuredBashPath(): string | null {
  const fromSetting = readString(SHELL_OPS_BASH_PATH_KEY);
  if (fromSetting) return fromSetting;
  const fromEnv = (process.env.CODEM_SHELL_OPS_BASH || "").trim();
  return fromEnv || null;
}

/** 显式配置的 PowerShell 7 路径（用于提示）。 */
export function configuredPwshPath(): string | null {
  const fromSetting = readString(SHELL_OPS_PWSH_PATH_KEY);
  if (fromSetting) return fromSetting;
  const fromEnv = (process.env.CODEM_SHELL_OPS_PWSH || "").trim();
  return fromEnv || null;
}

export type ShellKind = "bash" | "powershell";

export interface ShellPlan {
  /** 本次要用的执行器 */
  kind: ShellKind;
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
 */
export function mentionsWindowsPowerShell(command: string): boolean {
  return /(^|[\n;|]|&&|\|\|)\s*(?:[A-Za-z]:\\[^"'\s]*\\)?powershell(?:\.exe)?\b/i.test(command);
}

/** 命令里是否点名调用了 PowerShell 7（pwsh）。 */
export function mentionsPwsh7(command: string): boolean {
  return /(^|[\n;|]|&&|\|\|)\s*(?:[A-Za-z]:\\[^"'\s]*\\)?pwsh(?:\.exe)?\b/i.test(command);
}

/** 给模型的 PowerShell 7 出口提示（有显式配置就用它，否则给标准位置 + PATH 上的 pwsh）。 */
export function pwshRouteHint(): string {
  const explicit = configuredPwshPath();
  const list = [explicit, ...PWSH_STANDARD_PATHS].filter(Boolean) as string[];
  return `"${list[0]}"（或先运行 where pwsh 找到本机路径）`;
}

/**
 * 决定这条命令用哪个执行器 —— **唯一判定源**。
 *
 * - 插件关闭 ⇒ `powershell`（沿用旧行为：用户禁用插件后必须能回到原状）；
 * - 插件开启 + 命令点名 `powershell` ⇒ **拒绝**（5.1 的坑全在它身上），并给出 PS7 出口；
 * - 其它 ⇒ `bash`（bash 是否存在由 Rust 解析；解析不到时 Rust 侧拒绝执行，**不回退**）。
 */
export function resolveShellPlan(command: string): ShellPlan {
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
