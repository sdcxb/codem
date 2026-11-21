/**
 * Bash Command Deep Security Analyzer
 *
 * Design (from CLAUDE-CODE-IMPACT-ANALYSIS.md):
 *
 * 1. Incremental detection — adds patterns existing rules don't cover
 * 2. Only analyzes bash commands, not PowerShell
 * 3. If dangerous → override rawAction to "ask" (safety over user convenience)
 * 4. Doesn't replace existing permission rules — adds an extra layer
 *
 * Integration point: agentic-loop.ts toolHandler, before PermissionManager.evaluate()
 */

// ========== Types ==========

type BashCommandClassification = "readonly" | "write" | "dangerous";

export interface BashAnalysisResult {
  classification: BashCommandClassification;
  /** Detected dangerous patterns (empty if none) */
  dangerousPatterns: string[];
  /** Whether the command appears to be PowerShell (not analyzed) */
  isPowerShell: boolean;
}

// ========== Dangerous Patterns ==========

/**
 * Patterns that indicate a command is dangerous.
 * These go BEYOND the existing permission rules (rm -rf, sudo, etc.)
 * and detect command injection / exfiltration patterns.
 */
const DANGEROUS_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  // Command substitution — can execute arbitrary code
  { regex: /\$\(/, description: "Command substitution $() — can execute arbitrary code" },
  { regex: /`[^`]+`/, description: "Backtick command substitution — can execute arbitrary code" },

  // Process substitution — can redirect to/from arbitrary processes
  { regex: /<\(/, description: "Process substitution <() — can redirect from arbitrary process" },
  { regex: />\(/, description: "Process substitution >() — can redirect to arbitrary process" },

  // Piping to shell — executes arbitrary code from stdin
  { regex: /\|\s*(bash|sh|zsh|fish|dash|ksh)\b/i, description: "Piping to shell — executes arbitrary code from stdin" },

  // curl/wget piped to shell — remote code execution
  { regex: /(curl|wget)\s+[^|]*\|\s*(bash|sh|zsh)/i, description: "Remote code execution: curl/wget piped to shell" },

  // eval — executes arbitrary string as command
  { regex: /\beval\s+/i, description: "eval — executes arbitrary string as command" },

  // source with URL — executes remote script
  { regex: /\b(source|\.)\s+https?:\/\//i, description: "source with URL — executes remote script" },

  // /dev/tcp or /dev/udp — network connections via bash
  { regex: /\/dev\/(tcp|udp)\//i, description: "/dev/tcp or /dev/udp — network connection via bash" },

  // nc/netcat with execution flag
  { regex: /\b(nc|netcat)\s+.*-e\s+/i, description: "netcat with -e flag — executes command on connection" },

  // Environment variable expansion in dangerous context
  { regex: /\$\{(IFS|PATH|HOME|SHELL)\}/i, description: "Environment variable manipulation — can alter command behavior" },

  // Heredoc with command substitution
  { regex: /<<\s*\w+[\s\S]*?\$\(/, description: "Heredoc with command substitution — can inject code" },

  // xargs with rm
  { regex: /\bxargs\s+.*\brm\b/i, description: "xargs with rm — can delete files based on dynamic input" },

  // find with -exec
  { regex: /\bfind\b.*-exec\b/i, description: "find with -exec — can execute arbitrary command on matched files" },

  // dd with device target
  { regex: /\bdd\b.*\b(of=\/dev\/)/i, description: "dd writing to device — can destroy disk data" },

  // mkfs — filesystem format
  { regex: /\bmkfs\b/i, description: "mkfs — formats filesystem" },

  // systemctl stop/disable — can stop critical services
  { regex: /\bsystemctl\s+(stop|disable)\b/i, description: "systemctl stop/disable — can stop critical services" },

  // iptables flush — can disable firewall
  { regex: /\biptables\s+.*-F\b/i, description: "iptables flush — can disable firewall rules" },

  /* ===== 第 15 轮：破坏性文件/系统操作（与 PowerShell 清单对齐） =====
   *
   * 为什么补这一组：bash 侧原来只有「注入/外联」类模式，一个删除命令都没有 ——
   * rm -rf /tmp/x 被判成 write，在「请求批准」模式下直接执行、连弹窗都不出现。
   * PowerShell 侧一直有 Remove-Item -Recurse/-Force，这是跨平台的不对称缺口。
   */
  { regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, description: "fork bomb" },
];

/**
 * PowerShell 侧的**危险**命令（第 83 波审计修正）。
 *
 * 背景：本产品在 Windows 上的 shell 就是 PowerShell，而原来的实现
 * `if (isPowerShellCommand(command)) return { classification: "write", dangerousPatterns: [] }`
 * —— 只要命令以 `Get-/Set-/Remove-/Invoke-…` 开头（或含 `$env:`、`| Select-Object`），
 * 就**整段跳过危险分析**。于是"替我审批"模式下：
 *
 *   Remove-Item -Recurse -Force C:\Users\me\Documents
 *
 * 既不询问、也不拦截（`isAutoApprovable` 的 unix 正则一个都匹配不上）。
 * 这属于"闸门被分类绕过"，与第 83 波修的守卫短路是同一类问题。
 */
const POWERSHELL_DANGEROUS_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  { regex: /\bRemove-Item\b[\s\S]*(-Recurse|-Force)/i, description: "Remove-Item -Recurse/-Force — 递归/强制删除（PowerShell）" },
  { regex: /\b(rm|del|erase|rd|rmdir)\b[\s\S]*\s(-r|-rf|-recurse|-force|\/s|\/q)\b/i, description: "递归/强制删除" },
  { regex: /\bInvoke-Expression\b|\biex\b/i, description: "Invoke-Expression — 执行动态拼接的代码" },
  { regex: /\bInvoke-WebRequest\b[\s\S]*\|\s*(Invoke-Expression|iex)\b/i, description: "下载并直接执行远端脚本" },
  { regex: /\b(Invoke-WebRequest|iwr|curl|wget)\b[\s\S]*\|\s*(Invoke-Expression|iex)\b/i, description: "下载并直接执行远端脚本" },
  { regex: /\bStop-Computer\b|\bRestart-Computer\b/i, description: "关机/重启" },
  { regex: /\bFormat-Volume\b|\bClear-Disk\b|\bInitialize-Disk\b/i, description: "磁盘格式化/初始化" },
  { regex: /\bSet-ExecutionPolicy\b/i, description: "修改执行策略（降低安全限制）" },
  { regex: /\b(New-LocalUser|Add-LocalGroupMember)\b/i, description: "创建账号/提权" },
  { regex: /\bSet-Content\b[\s\S]*\$env:/i, description: "批量覆盖环境相关文件" },
  { regex: /\bStart-Process\b[\s\S]*-(Verb\s+RunAs|WindowStyle\s+Hidden)/i, description: "提权/隐藏窗口启动进程" },
];

/**
 * PowerShell 侧的**只读**命令（避免把正常查询当成"会改盘"）。
 */
const POWERSHELL_READONLY_RE =
  /^\s*(Get-|Test-Path|Resolve-Path|Select-String|Measure-Object|Where-Object|Sort-Object|Format-|Out-String|Compare-Object|ConvertFrom-)/i;
/**
 * Patterns that indicate a command is read-only (safe).
 * Used to classify commands when no dangerous patterns are found.
 */
const READONLY_PATTERNS: RegExp[] = [
  /^git\s+(status|log|diff|show|branch|tag|remote|rev-parse|ls-files|blame)\b/i,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^find\b.*(?<!-exec)/i,
  /^wc\b/,
  /^file\b/,
  /^stat\b/,
  /^du\b/,
  /^df\b/,
  /^ps\b/,
  /^top\b/,
  /^echo\b/,
  /^printf\b/,
  /^pwd\b/,
  /^whoami\b/,
  /^which\b/,
  /^whereis\b/,
  /^date\b/,
  /^env\b(?!.*=\S)/,
  /^printenv\b/,
  /^node\s+--version/i,
  /^npm\s+(list|ls|view|info|outdated)\b/i,
  /^cargo\s+--version/i,
  /^python\s+--version/i,
];

/**
 * Patterns that indicate a command modifies the system (but is not dangerous).
 */
const WRITE_PATTERNS: RegExp[] = [
  /^git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|fetch|clone|init)\b/i,
  /^npm\s+(install|uninstall|update|publish|run)\b/i,
  /^cargo\s+(build|run|test|install|publish)\b/i,
  /^pip\s+install\b/i,
  /^python\s+.*\.py\b/,
  /^node\s+.*\.js\b/,
  /^mkdir\b/,
  /^touch\b/,
  /^cp\b/,
  /^mv\b/,
  /^tar\b/,
  /^zip\b/,
  /^unzip\b/,
  /^wget\b(?!.*\|\s*(bash|sh))/i,
  /^curl\b(?!.*\|\s*(bash|sh))/i,
];

// ========== 第 15 轮：按命令段分类 ==========

/**
 * 把复合命令按 ; && || | 换行 切成段，逐段判断破坏性。
 *
 * 为什么必须分段：旧实现只看「第一个命令词」（`command.split("|")[0]`），于是
 * `echo hi; Remove-Item -Recurse -Force C:\\x` 会被判 readonly（首词 echo），
 * `find . -delete` 甚至命中 READONLY_PATTERNS。分段后取「最严重」的那一段。
 */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/;|&&|\|\||\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 去掉段首的提权/包装前缀，返回真正的命令文本（用于命令位置匹配）。 */
function stripSegmentPrefix(seg: string): string {
  return seg.replace(/^(?:sudo|doas|command|env|time|nohup)\s+/i, "").trim();
}

/**
 * 单段破坏性判断：**只在命令位置匹配**（避免 `grep "rm -rf"`、`git log --grep=shutdown` 误报）。
 * 返回 null = 不是破坏性命令。
 */
function classifyDestructiveSegment(seg: string): string | null {
  const raw = seg.trim();
  const rawFirst = (raw.split(/\s+/)[0] || "").toLowerCase();
  /* 提权前缀本身就算破坏性（剥掉之后就只剩 ls 了，不能让它变安全） */
  if (["sudo", "su", "doas"].includes(rawFirst)) return "提权执行（sudo/su）";
  const s = stripSegmentPrefix(seg);
  const first = (s.split(/\s+/)[0] || "").toLowerCase();
  const rest = s.slice(first.length).trim();
  const has = (re: RegExp) => re.test(s);

  // 设备写入（任意位置，目标明确）
  if (/>\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk)/i.test(s)) return "直接写块设备（> /dev/sdX）";
  // 删除/清理
  if (first === "rm" && (/(?:^|\s)-(?:[A-Za-z]*[rRf][A-Za-z]*)\b/.test(rest) || /--(?:recursive|force)\b/i.test(rest))) {
    return "递归/强制删除（rm -r/-f）";
  }
  if (["del", "erase", "rd", "rmdir"].includes(first)) return "删除命令（Windows del/rd）";
  if (first === "find" && /\s-delete\b/i.test(rest)) return "find -delete — 批量删除文件";
  if (["shred", "wipe", "srm", "rimraf"].includes(first)) return "不可恢复删除/目录删除";
  if (first === "truncate" && /-s\s*0\b/.test(rest)) return "truncate -s 0 — 清零文件";
  // git 数据丢失类
  if (first === "git") {
    const sub = (rest.split(/\s+/)[0] || "").toLowerCase();
    if (sub === "clean" && /(?:^|\s)-[a-z]*f[a-z]*\b/i.test(rest)) return "git clean -f — 删除未跟踪文件";
    if (sub === "push" && /(?:--force\b|\s-f\b)/i.test(rest)) return "git push --force — 覆盖远端历史";
    if (sub === "reset" && /--hard\b/i.test(rest)) return "git reset --hard — 丢弃工作区改动";
    if (["checkout", "restore"].includes(sub) && /(?:^|\s)(?:\.|--\s+\.)$/.test(rest.trim())) return "git checkout/restore . — 丢弃全部改动";
    if (sub === "branch" && /(?:^|\s)-D\b/.test(rest)) return "git branch -D — 强制删除分支";
    if (sub === "stash" && /\b(?:drop|clear)\b/i.test(rest)) return "git stash drop/clear — 丢弃暂存";
  }
  // 权限/提权/关机
  if (["chmod", "chown"].includes(first)) return "修改权限/属主（chmod/chown）";
  if (["sudo", "su"].includes(first)) return "提权执行（sudo/su）";
  if (["shutdown", "reboot", "halt", "poweroff"].includes(first)) return "关机/重启";
  // 进程
  if (first === "kill" && /(?:^|\s)-(?:9|KILL)\b/i.test(rest)) return "kill -9 — 强制杀进程";
  if (["killall", "pkill"].includes(first)) return "批量杀进程（killall/pkill）";
  // Windows 磁盘/系统/账号
  if (["format", "diskpart", "bcdedit", "vssadmin", "icacls", "takeown", "cipher"].includes(first)) return "Windows 磁盘/系统修改命令";
  if (["wmic"].includes(first) && /\bdelete\b/i.test(rest)) return "wmic 删除操作";
  if (first === "sc" && /\bdelete\b/i.test(rest)) return "sc delete — 删除服务";
  if (first === "reg" && /\bdelete\b/i.test(rest)) return "reg delete — 删除注册表项";
  if (first === "net" && /\buser\b/i.test(rest)) return "net user — 账号修改";
  // PowerShell cmdlet（可能在 wrapper 后面，也可能大小写混写）
  if (/\bRemove-Item\b[\s\S]*-(?:Recurse|Force)\b/i.test(s)) return "Remove-Item -Recurse/-Force — 递归/强制删除";
  if (/\b(?:Invoke-Expression|iex)\b/i.test(s)) return "Invoke-Expression — 执行动态拼接的代码";
  if (/\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i.test(s)) return "磁盘格式化/初始化";
  if (/\bSet-ExecutionPolicy\b/i.test(s)) return "修改执行策略（降低安全限制）";
  if (/\b(?:Stop-Computer|Restart-Computer)\b/i.test(s)) return "关机/重启";
  return null;
}

// ========== Core Analysis ==========

/**
 * Detect if a command is a PowerShell command (not bash).
 * On Windows, the bash tool uses PowerShell. We should not analyze
 * PowerShell commands with bash-specific patterns.
 */
function isPowerShellCommand(command: string): boolean {
  // Common PowerShell cmdlets
  const psCmdlets = /^(Get-|Set-|New-|Remove-|Invoke-|Start-|Stop-|Enable-|Disable-|Export-|Import-|ConvertTo-|ConvertFrom-|Out-|Write-|Read-|Test-|Select-|Where-|ForEach-|Measure-|Sort-|Group-|Compare-|Trace-|Wait-|Debug-|Update-|Add-|Clear-|Push-|Pop-|Use-|Register-|Unregister-|Suspend-|Resume-|Block-|Unblock-|Connect-|Disconnect-|Enter-|Exit-|Watch-|Format-|Optimize-|Repair-|Reset-|Restart-|Rename-|Move-|Copy-|Mount-|Dismount-)/;
  if (psCmdlets.test(command.trim())) return true;

  // PowerShell-specific operators
  if (command.includes("$env:") || command.includes("| Select-Object") || command.includes("| Where-Object")) {
    return true;
  }

  // PowerShell aliases that don't exist in bash
  if (/\b(Get-ChildItem|Get-Content|Get-Location|Set-Location)\b/.test(command)) return true;

  return false;
}

/**
 * Analyze a bash command for dangerous patterns.
 *
 * @param command - The bash command to analyze
 * @returns Classification result with detected patterns
 */
export function analyzeBashCommand(command: string): BashAnalysisResult {
  /* 第 15 轮：先按段判破坏性命令（复合命令/命令位置锚定），再走原来的注入模式与只读/写分类 */
  const segmentDangers: string[] = [];
  for (const seg of splitCommandSegments(command)) {
    const hit = classifyDestructiveSegment(seg);
    if (hit) segmentDangers.push(hit);
  }
  if (segmentDangers.length > 0) {
    return { classification: "dangerous", dangerousPatterns: Array.from(new Set(segmentDangers)), isPowerShell: isPowerShellCommand(command) };
  }

  /**
   * PowerShell 命令**不再跳过分析**（第 83 波审计修正）。
   *
   * 本产品在 Windows 上的 shell 就是 PowerShell，而原来这里直接
   * `return { classification: "write", dangerousPatterns: [] }` —— 等于在 Windows 上
   * 把唯一的自动闸门关掉：`Remove-Item -Recurse -Force …`、`Invoke-Expression …`
   * 都成了"write"，在"替我审批"模式下被自动放行（`isAutoApprovable` 的 unix 正则也匹配不上）。
   * 现在用 PowerShell 侧的危险/只读清单做同样的分级。
   */
  if (isPowerShellCommand(command)) {
    const psDetected: string[] = [];
    for (const { regex, description } of POWERSHELL_DANGEROUS_PATTERNS) {
      if (regex.test(command)) psDetected.push(description);
    }
    if (psDetected.length > 0) {
      return { classification: "dangerous", dangerousPatterns: psDetected, isPowerShell: true };
    }
    if (POWERSHELL_READONLY_RE.test(command)) {
      return { classification: "readonly", dangerousPatterns: [], isPowerShell: true };
    }
    return { classification: "write", dangerousPatterns: [], isPowerShell: true };
  }

  // Check for dangerous patterns
  const detectedPatterns: string[] = [];
  for (const { regex, description } of DANGEROUS_PATTERNS) {
    if (regex.test(command)) {
      detectedPatterns.push(description);
    }
  }

  if (detectedPatterns.length > 0) {
    return {
      classification: "dangerous",
      dangerousPatterns: detectedPatterns,
      isPowerShell: false,
    };
  }

  /**
   * 第 83 波（审计修正）：**有输出重定向就不是只读**。
   *
   * 原来 `echo hi > out.txt`、`ls -la > list.txt` 会因为首个命令词是 `echo`/`ls`
   * 被 READONLY_PATTERNS 判成 readonly —— 而它们确实在写文件
   * （计划模式的只读契约、auto 模式的自动放行都会因此放错）。
   */
  if (/(^|[^>])>>?(\s|$|[^>&])/.test(command)) {
    return { classification: "write", dangerousPatterns: [], isPowerShell: false };
  }

  // Classify as readonly or write
  // Split by pipes and check the first command
  const firstCommand = command.split("|")[0].trim();

  for (const pattern of READONLY_PATTERNS) {
    if (pattern.test(firstCommand)) {
      return {
        classification: "readonly",
        dangerousPatterns: [],
        isPowerShell: false,
      };
    }
  }

  for (const pattern of WRITE_PATTERNS) {
    if (pattern.test(firstCommand)) {
      return {
        classification: "write",
        dangerousPatterns: [],
        isPowerShell: false,
      };
    }
  }

  // Default: treat as write (conservative)
  return {
    classification: "write",
    dangerousPatterns: [],
    isPowerShell: false,
  };
}

/**
 * Determine if a command should be blocked based on the analysis.
 * Returns "ask" if dangerous, otherwise returns the original action.
 *
 * This function is called BEFORE PermissionManager.evaluate() so that
 * dangerous patterns override user "allow" rules.
 */
export function evaluateWithBashAnalysis(
  command: string,
  originalAction: "allow" | "deny" | "ask",
): { action: "allow" | "deny" | "ask"; reason?: string } {
  const analysis = analyzeBashCommand(command);

  if (analysis.classification === "dangerous") {
    // Only upgrade "allow" to "ask" — never downgrade "deny"
    if (originalAction === "allow") {
      return {
        action: "ask",
        reason: `Security: Detected dangerous patterns: ${analysis.dangerousPatterns.join("; ")}`,
      };
    }
    // If already "deny" or "ask", keep it
    return { action: originalAction, reason: analysis.dangerousPatterns.length > 0 ? `Dangerous patterns: ${analysis.dangerousPatterns.join("; ")}` : undefined };
  }

  return { action: originalAction };
}
