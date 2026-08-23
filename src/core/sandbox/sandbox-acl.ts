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
    const normalized = path.replace(/\\/g, "/");

    // 1. 检查黑名单（优先）
    for (const blocked of this.policy.blockedPaths) {
      const pattern = blocked.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
      const regex = new RegExp(`^${pattern}`, "i");
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
