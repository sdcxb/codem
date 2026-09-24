/**
 * Process-Level Sandbox — 进程级沙箱 ACL 前端接口层
 *
 * 设计对标 DSH `sandbox/` + Landlock/Seatbelt。
 *
 * D2: 实现前端 ACL（访问控制列表）层，包括：
 * - 路径白名单/黑名单（文件读写权限控制）
 * - 命令黑名单（危险命令阻断）
 * - 环境变量过滤（敏感变量隔离）
 * - 网络访问控制（可选）
 *
 * 前端 ACL 是第一道防线，在命令/文件操作到达 Rust 后端之前进行拦截。
 * 完整的内核级沙箱（Landlock on Linux, Seatbelt on macOS）需要 Rust 后端实现。
 *
 * 架构：
 * 1. SandboxPolicy — 策略定义（哪些路径/命令允许/拒绝）
 * 2. SandboxGuard — 前端拦截器（在工具执行前检查）
 * 3. SandboxExecutor — 命令执行包装器（可选：在沙箱目录中执行）
 */

// ========== Glob → Regex（第 84 波修正） ==========

import { getSetting, setSetting, removeSetting } from "../storage/settings";
import { reportActionFailure } from "../storage/persist-failure";

/**
 * 沙箱模式的设置键 —— **必须与设置面板里的开关一致**
 * （`SettingsPanel.tsx` 的 "🔒 沙箱模式（限制写入范围到工作目录）" 写的就是这个键）。
 *
 * 第 87 波（接线修复）：这个开关此前是个"装饰品" —— 面板能勾、界面显示已开启，
 * 而 `AgenticLoop` 里传给工具管线的 `isSandboxEnabled` 是硬编码 `() => false`，
 * `SandboxGuard` 从来没有真正启用过。现在两处用同一个键。
 */
export const SANDBOX_SETTING_KEY = "codem-sandbox-enabled";

/**
 * 上一次**成功读到**的沙箱开关值（第 87 轮）。
 *
 * 为什么要有它：这是个**安全开关**，而 `getSetting` 读失败时原来的写法是"按关闭处理" ——
 * 也就是**用户明确打开的沙箱，在一次读失败之后会静默失效**（界面上的开关还显示"已开启"）。
 * 这与第 86 轮修的那个洞（`hasUncommittedChanges` 失败被当成"工作区干净"）是同一类：
 * **问不到 ≠ 用户关掉了**。
 *
 * 现在：读失败时优先沿用**上次成功读到的值**（sticky），并把这次失败**走上报通道**
 * （横幅可见），而不是只在控制台留一句 warn。没有任何历史值时仍按产品默认（关闭）处理，
 * 但同样如实上报 —— 用户至少知道"这个开关这次没被确认"。
 */
let lastKnownSandboxEnabled: boolean | null = null;

/**
 * 沙箱模式是否开启（默认关闭；与面板默认一致）。
 *
 * ⚠️ 读失败时**不再静默**：优先返回上次成功读到的值（有的话），并上报；
 * 没有历史值时返回 false，同样上报 —— 让"这次没能确认"变成用户可见的事实。
 */
export function isSandboxAclEnabled(): boolean {
  try {
    const enabled = getSetting(SANDBOX_SETTING_KEY) === "true";
    lastKnownSandboxEnabled = enabled;
    return enabled;
  } catch (e) {
    if (lastKnownSandboxEnabled !== null) {
      reportActionFailure(
        "sandbox.readSetting",
        e,
        `读取沙箱设置失败，已沿用上次成功读到的值（${lastKnownSandboxEnabled ? "开启" : "关闭"}）`,
      );
      return lastKnownSandboxEnabled;
    }
    reportActionFailure(
      "sandbox.readSetting",
      e,
      "读取沙箱设置失败，且没有历史值 —— 本次按「关闭」处理（界面上的开关不代表本次实际生效状态）",
    );
    return false;
  }
}

/** 用例用：清掉"上次成功读到"的记忆，避免用例之间互相影响 */
export function __resetSandboxSettingCache(): void {
  lastKnownSandboxEnabled = null;
}

/**
 * 写入沙箱模式开关。
 * @returns 是否真的写进了设置（false = 只在本次运行内生效，重启后回到旧值）
 */
export function setSandboxAclEnabled(enabled: boolean): boolean {
  try {
    if (enabled) setSetting(SANDBOX_SETTING_KEY, "true");
    else removeSetting(SANDBOX_SETTING_KEY);
    return true;
  } catch (e) {
    console.error("[Sandbox] 沙箱设置写入失败（仅本次运行内生效）：", e);
    return false;
  }
}


/** 用户主目录（正斜杠形式）；浏览器环境取不到时为 null */
function homeDir(): string | null {
  try {
    const home =
      (typeof process !== "undefined" && (process.env?.USERPROFILE || process.env?.HOME)) || "";
    return home ? home.replace(/\\/g, "/").replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * 规范化沙箱路径：反斜杠 → `/`，并把开头的 `~` 展开成真实主目录。
 *
 * 第 84 波：**输入路径和黑名单条目必须用同一套规范化**。只规范化一边的话，
 * `~/.ssh` 这种条目要么永远匹配不上真实路径（`C:/Users/x/.ssh/id_rsa`），
 * 要么只能匹配写字面量 `~` 的调用 —— 两种都不是我们要的。
 */
export function normalizeSandboxPath(p: string): string {
  let out = String(p ?? "").replace(/\\/g, "/");
  const home = homeDir();
  if (home && (out === "~" || out.startsWith("~/"))) {
    out = home + out.slice(1);
  }
  return out;
}

/**
 * 把黑名单里的 glob / 路径写成真正能匹配的**正则**。
 *
 * 第 84 波（审计修正）：原来的实现在真机（Windows）上**几乎全部失效**：
 *
 *   旧实现：把条目里的双星号替换成 `.*`、单星号替换成 `[^/]*` 之后，
 *   用 `new RegExp("^" + pattern, "i")` 直接匹配规范化过的输入路径。
 *   · 黑名单条目**没有被规范化**（只有输入路径把反斜杠换成斜杠），于是 `"C:\\Windows"`
 *     进了正则变成 `^C:\W...` —— `\W` 是"非单词字符"，`C:/Windows` 永远匹配不上；
 *   · `~/.ssh`、`~/.gnupg`、`~/.aws` 里的 `~` 从不展开，等于死规则
 *     （真正要保护的 `C:/Users/x/.ssh/id_rsa` 完全放行）；
 *   · 前缀匹配没有边界，双星号 + `/.env` 会连 `.environment.ts` 一起拦（误伤）。
 *
 * 现在的语义：
 *   · 双星号 + 斜杠 → 任意层级（含零层）；单星号 → 单层内任意字符；
 *   · 条目里的反斜杠统一成 `/`、`~` 展开为主目录；
 *   · 结尾不是星号的模式要求紧跟 `$`、`/` 或 `.`（既能拦住 `.env.local`，
 *     又不会误伤 `.environment.ts`）。
 */
export function sandboxGlobToRegex(glob: string): RegExp {
  const pattern = normalizeSandboxPath(glob);

  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"; // 双星斜杠 → 任意层级（含零层）
          i += 2;
        } else {
          out += ".*"; // 结尾的双星号
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if ("^$.|?+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  /**
   * 尾部边界：
   *   · 以星号结尾         → 严格锚定 `$`（单星号只匹配一层，不越级）
   *   · 含星号、末段是点文件 → 允许 `$` / `/` / `.`（`**` + `/.env` 也能拦住 `.env.local`）
   *   · 含星号、末段是普通名 → 允许 `$` / `/`
   *   · 完全不含星号（`/etc`、`C:/Windows`、`~/.ssh`）= 目录式规则 → 连它下面的所有内容一起拦
   */
  const lastSegment = pattern.split("/").pop() ?? "";
  const suffix = /\*$/.test(pattern)
    ? "$"
    : !pattern.includes("*") || lastSegment.startsWith(".")
      ? "(?=$|[/.])"
      : "(?=$|/)";
  return new RegExp("^" + out + suffix, "i");
}

// ========== Types ==========

export interface SandboxPolicy {
  /** 允许读写的路径白名单（前缀匹配） */
  allowedPaths: string[];
  /** 禁止访问的路径黑名单（优先于白名单） */
  blockedPaths: string[];
  /** 禁止执行的命令模式（正则或通配符） */
  blockedCommands: string[];
  /** 禁止访问的环境变量名 */
  blockedEnvVars: string[];
  /** 是否禁止网络访问 */
  blockNetwork: boolean;
  /** 沙箱根目录（命令在此目录中执行） */
  rootPath?: string;
  /** 额外可写路径（只读白名单之外允许写入的路径） */
  writablePaths?: string[];
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason: string;
  /** 被拦截的资源 */
  resource?: string;
  /** 匹配的规则 */
  rule?: string;
}

// ========== Default Policies ==========

/** 默认安全策略 — 限制在工作区内，阻止危险操作 */
export function createDefaultPolicy(workspacePath: string): SandboxPolicy {
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/");
  return {
    allowedPaths: [
      normalizedWorkspace,
      // 系统临时目录（工具执行可能需要）
      "/tmp",
      "/var/tmp",
      // Windows temp
      `${(typeof process !== 'undefined' && process.env?.TEMP) || ""}`.replace(/\\/g, "/"),
      `${(typeof process !== 'undefined' && process.env?.TMP) || ""}`.replace(/\\/g, "/"),
    ].filter(Boolean),
    blockedPaths: [
      // 系统关键目录
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/boot",
      "/dev",
      "/proc",
      "/sys",
      "C:\\Windows",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      // 用户敏感目录
      "~/.ssh",
      "~/.gnupg",
      "~/.aws",
      "~/.config/gcloud",
      // 凭证文件
      "**/.env",
      "**/.env.local",
      "**/.env.production",
      "**/credentials.json",
      "**/service-account.json",
    ],
    blockedCommands: [
      // 危险命令模式
      "rm\\s+-rf\\s+/",
      "rm\\s+-rf\\s+~",
      "rm\\s+-rf\\s+\\*",
      "mkfs",
      "dd\\s+if=",
      ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:", // fork bomb
      "chmod\\s+-R\\s+777\\s+/",
      "curl\\s+.*\\|\\s*sh",  // pipe to shell
      "wget\\s+.*\\|\\s*sh",
      "curl\\s+.*\\|\\s*bash",
      "wget\\s+.*\\|\\s*bash",
      ">\\s*/dev/sda",
      "shutdown",
      "reboot",
      "halt",
      "init\\s+0",
    ],
    blockedEnvVars: [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "DATABASE_URL",
      "DATABASE_PASSWORD",
      "REDIS_URL",
      "REDIS_PASSWORD",
      "JWT_SECRET",
    ],
    blockNetwork: false,
    rootPath: normalizedWorkspace,
    writablePaths: [normalizedWorkspace],
  };
}

/** 高安全策略 — 严格限制，仅允许工作区读写 */
export function createStrictPolicy(workspacePath: string): SandboxPolicy {
  const base = createDefaultPolicy(workspacePath);
  return {
    ...base,
    blockNetwork: true,
    writablePaths: [workspacePath],
    blockedCommands: [
      ...base.blockedCommands,
      "apt",
      "apt-get",
      "yum",
      "brew",
      "pip\\s+install",
      "npm\\s+install",
      "yarn\\s+add",
      "cargo\\s+install",
    ],
  };
}

// ========== Sandbox Guard ==========

export class SandboxGuard {
  private policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  /** 更新策略 */
  updatePolicy(policy: SandboxPolicy): void {
    this.policy = policy;
  }

  /** 检查文件路径是否允许访问 */
  checkPath(path: string, mode: "read" | "write" = "read"): SandboxCheckResult {
    // 第 84 波：输入路径与黑名单条目用同一套规范化（反斜杠 + `~` 展开）
    const normalized = normalizeSandboxPath(path);

    // 1. 检查黑名单（优先）
    for (const blocked of this.policy.blockedPaths) {
      // 第 84 波：黑名单条目也要规范化 + `~` 展开 + 正确 glob 语义（见 sandboxGlobToRegex）
      const regex = sandboxGlobToRegex(blocked);
      if (regex.test(normalized)) {
        return {
          allowed: false,
          reason: `Path is blocked by sandbox policy`,
          resource: path,
          rule: blocked,
        };
      }
    }

    // 2. 检查白名单
    let inAllowed = false;
    for (const allowed of this.policy.allowedPaths) {
      if (normalized.startsWith(allowed)) {
        inAllowed = true;
        break;
      }
    }

    // 3. 写操作需要额外检查 writablePaths
    if (mode === "write" && this.policy.writablePaths) {
      let inWritable = false;
      for (const writable of this.policy.writablePaths) {
        if (normalized.startsWith(writable)) {
          inWritable = true;
          break;
        }
      }
      if (!inWritable) {
        return {
          allowed: false,
          reason: `Write outside writable paths`,
          resource: path,
          rule: "writablePaths",
        };
      }
    }

    if (!inAllowed) {
      return {
        allowed: false,
        reason: `Path outside allowed paths`,
        resource: path,
        rule: "allowedPaths",
      };
    }

    return { allowed: true, reason: "ok" };
  }

  /** 检查命令是否允许执行 */
  checkCommand(command: string): SandboxCheckResult {
    const trimmed = command.trim();

    // Check blocked commands
    for (const blocked of this.policy.blockedCommands) {
      const regex = new RegExp(blocked, "i");
      if (regex.test(trimmed)) {
        return {
          allowed: false,
          reason: `Command blocked by sandbox policy`,
          resource: command,
          rule: blocked,
        };
      }
    }

    // Check network commands if blockNetwork is true
    if (this.policy.blockNetwork) {
      const networkCommands = [
        "curl\\s",
        "wget\\s",
        "nc\\s",
        "netcat\\s",
        "ssh\\s",
        "scp\\s",
        "rsync\\s",
        "ftp\\s",
        "telnet\\s",
      ];
      for (const pattern of networkCommands) {
        const regex = new RegExp(pattern, "i");
        if (regex.test(trimmed)) {
          return {
            allowed: false,
            reason: `Network command blocked by strict sandbox policy`,
            resource: command,
            rule: `blockNetwork: ${pattern}`,
          };
        }
      }
    }

    return { allowed: true, reason: "ok" };
  }

  /** 检查环境变量是否允许访问 */
  checkEnvVar(name: string): SandboxCheckResult {
    for (const blocked of this.policy.blockedEnvVars) {
      if (name.toUpperCase() === blocked.toUpperCase()) {
        return {
          allowed: false,
          reason: `Environment variable is blocked by sandbox policy`,
          resource: name,
          rule: blocked,
        };
      }
    }
    return { allowed: true, reason: "ok" };
  }

  /** 过滤环境变量 — 移除被阻止的变量 */
  filterEnv(env: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (this.checkEnvVar(key).allowed) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  /** 获取当前策略 */
  getPolicy(): SandboxPolicy {
    return this.policy;
  }
}

// ========== Singleton ==========

let guardInstance: SandboxGuard | null = null;

export function getSandboxGuard(): SandboxGuard | null {
  return guardInstance;
}

export function initSandboxGuard(policy: SandboxPolicy): SandboxGuard {
  guardInstance = new SandboxGuard(policy);
  return guardInstance;
}

export function initDefaultSandbox(workspacePath: string): SandboxGuard {
  return initSandboxGuard(createDefaultPolicy(workspacePath));
}
