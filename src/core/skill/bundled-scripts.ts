/**
 * Bundled Scripts — 通用脚本注册和执行
 *
 * C2: 让 skill 可以携带可执行脚本（scripts/ 目录），
 * 用于确定性任务（格式化、验证、生成等）。
 *
 * DSH 实践：skill 的 scripts/ 目录包含可执行脚本，
 * skill prompt 引用这些脚本来完成确定性工作。
 *
 * 工作机制：
 * 1. Skill 发现时扫描 scripts/ 目录
 * 2. 注册到 BundledScriptRegistry
 * 3. Agent 可以通过 run_script 工具调用
 * 4. 脚本在沙箱中执行，有超时和权限限制
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ========== Types ==========

export interface BundledScript {
  /** 脚本唯一名称（skill_name/script_name 格式） */
  name: string;
  /** 脚本文件路径 */
  filePath: string;
  /** 脚本描述（从 SKILL.md 或文件名推断） */
  description: string;
  /** 所属 skill 名 */
  skillName: string;
  /** 超时（毫秒，默认 30000） */
  timeout: number;
  /** 支持的 shell 类型 */
  shellTypes: string[];
}

export interface ScriptRunOptions {
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 超时覆盖 */
  timeout?: number;
  /** 参数 */
  args?: string[];
  /** stdin 输入 */
  stdin?: string;
}

export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// ========== BundledScriptRegistry ==========

class BundledScriptRegistry {
  private scripts: Map<string, BundledScript> = new Map();

  /** 注册一个脚本 */
  register(script: BundledScript): void {
    this.scripts.set(script.name, script);
  }

  /** 注销一个脚本 */
  unregister(name: string): boolean {
    return this.scripts.delete(name);
  }

  /** 获取脚本信息 */
  get(name: string): BundledScript | undefined {
    return this.scripts.get(name);
  }

  /** 列出所有脚本 */
  list(): BundledScript[] {
    return Array.from(this.scripts.values());
  }

  /** 列出某 skill 的所有脚本 */
  listBySkill(skillName: string): BundledScript[] {
    return this.list().filter((s) => s.skillName === skillName);
  }

  /** 清除某 skill 的所有脚本 */
  unregisterBySkill(skillName: string): number {
    const toRemove = this.listBySkill(skillName);
    for (const script of toRemove) {
      this.scripts.delete(script.name);
    }
    return toRemove.length;
  }

  /** 执行一个脚本 */
  async run(name: string, options: ScriptRunOptions = {}): Promise<ScriptRunResult> {
    const script = this.scripts.get(name);
    if (!script) {
      throw new Error(`Script "${name}" not found`);
    }

    const timeout = options.timeout ?? script.timeout;
    const cwd = options.cwd ?? path.dirname(script.filePath);

    try {
      const { stdout, stderr } = await execFileAsync(
        script.filePath,
        options.args ?? [],
        {
          cwd,
          env: { ...process.env, ...options.env },
          timeout,
          maxBuffer: 1024 * 1024, // 1MB
          ...(options.stdin ? { input: options.stdin } : {}),
        } as Parameters<typeof execFileAsync>[2],
      );

      return {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: 0,
        timedOut: false,
      };
    } catch (error: any) {
      if (error.killed === true) {
        return {
          stdout: error.stdout?.toString() ?? "",
          stderr: error.stderr?.toString() ?? "",
          exitCode: -1,
          timedOut: true,
        };
      }
      return {
        stdout: error.stdout?.toString() ?? "",
        stderr: error.stderr?.toString() ?? error.message,
        exitCode: error.code ?? 1,
        timedOut: false,
      };
    }
  }

  /** 扫描 skill 目录的 scripts/ 子目录并注册 */
  scanAndRegister(skillDir: string, skillName: string): number {
    const scriptsDir = path.join(skillDir, "scripts");
    if (!fs.existsSync(scriptsDir)) return 0;

    let count = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filePath = path.join(scriptsDir, entry.name);
      const ext = path.extname(entry.name);
      const baseName = path.basename(entry.name, ext);

      // 确定脚本名称和 shell 类型
      let shellTypes: string[] = [];
      if (ext === ".ps1" || ext === ".psm1") {
        shellTypes = ["powershell"];
      } else if (ext === ".sh" || ext === ".bash") {
        shellTypes = ["bash", "sh"];
      } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        shellTypes = ["node"];
      } else if (ext === ".ts") {
        shellTypes = ["deno", "tsx"];
      } else if (ext === ".py") {
        shellTypes = ["python"];
      } else {
        continue; // 跳过不支持的文件类型
      }

      // 确保文件可执行（Unix 系统）
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(filePath, 0o755);
        } catch {}
      }

      const scriptName = `${skillName}/${baseName}`;

      this.register({
        name: scriptName,
        filePath,
        description: `Script from skill "${skillName}"`,
        skillName,
        timeout: 30000,
        shellTypes,
      });
      count++;
    }

    return count;
  }
}

// ========== Singleton ==========

const registry = new BundledScriptRegistry();

export function getBundledScriptRegistry(): BundledScriptRegistry {
  return registry;
}
