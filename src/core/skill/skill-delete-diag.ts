/**
 * 技能删除诊断轨迹（第 72 波）
 *
 * 背景：用户报告「技能管理里删除技能卡死」，并且**控制台连一条 `[SkillInstaller]` 都没有**，
 * 整个窗口也点不动。这种情况控制台帮不上忙：卡点可能发生在"点击 → 进入删除逻辑"之间，
 * 而且窗口一旦冻结/渲染进程一旦消失，控制台里的线索也一起消失。
 *
 * 所以这条链路必须留下**落盘**的轨迹，回答四个问题：
 *   1. 点击有没有到达处理函数？（`delete button clicked` / `confirm action fired`）
 *   2. 如果到达了，目标是谁？（技能名 / 来源 / 目录路径）
 *   3. 每一步之间隔了多久？（每行都带相对毫秒）
 *   4. 冻结期间主线程还在跑吗？（`heartbeat` 行里的 drift：漂移远大于间隔 = 主线程被卡住）
 *
 * 文件：`<appData>/.codem/skills-delete-diag.log`（每次应用启动重写一次，单文件上限约 256 KB）。
 *
 * 设计约束（重要）：**绝不抛错、绝不阻塞**。诊断只是旁路，任何写盘失败都不能影响删除本身，
 * 所以每个入口都包 try/catch，写盘 fire-and-forget（不 await）。
 */

import { getAppDataDir, writeFile, appendFile } from "../file-api";

/** 会话内累计写入行数（用于判定"文件可能过大"） */
let linesWritten = 0;
/** 是否已写过会话头 */
let headerWritten = false;
/** 会话开始时间（相对时间戳基准） */
const startedAt = Date.now();

/** 单文件上限行数：约 256 KB（每行 ~100B） */
const MAX_LINES = 2600;

let filePathCache: string | null = null;

async function diagPath(): Promise<string | null> {
  if (filePathCache) return filePathCache;
  try {
    const dir = await getAppDataDir();
    const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
    filePathCache = `${dir}.codem${sep}skills-delete-diag.log`;
    return filePathCache;
  } catch {
    return null;
  }
}

function format(value: string): string {
  if (value.length <= 400) return value;
  return `${value.slice(0, 400)}…(共 ${value.length} 字符)`;
}

function line(event: string, detail?: Record<string, unknown>): string {
  const rel = String(Date.now() - startedAt).padStart(6, " ");
  let suffix = "";
  if (detail) {
    try {
      suffix = ` ${format(JSON.stringify(detail))}`;
    } catch {
      suffix = " <detail 序列化失败>";
    }
  }
  return `+${rel}ms ${new Date().toISOString()} ${event}${suffix}`;
}

/**
 * 记录一条诊断事件（落盘 + 控制台回显）。
 *
 * 控制台回显保留，因为多数情况下面板里直接就能看到；落盘用于"窗口冻结 / 渲染进程消失"时事后取证。
 */
export function diagTrail(event: string, detail?: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`[SkillDiag] ${event}`, detail ?? "");
  } catch {
    /* 控制台不可用也不影响落盘 */
  }
  void (async () => {
    try {
      const path = await diagPath();
      if (!path) return;
      if (linesWritten >= MAX_LINES) return; // 够用了，别再写
      const text = `${line(event, detail)}\n`;
      if (!headerWritten) {
        headerWritten = true;
        await writeFile(
          path,
          `${line("session start", { version: "runtime", appData: path })}\n${text}`,
        );
      } else {
        await appendFile(path, text);
      }
      linesWritten++;
    } catch {
      /* 诊断写盘失败绝不影响功能 */
    }
  })();
}

/** 测试/会话重置用：清掉模块级状态 */
export function resetDiagState(): void {
  linesWritten = 0;
  headerWritten = false;
  filePathCache = null;
}

/**
 * 主线程心跳：每 `intervalMs` 写一行，并报告"实际间隔 - 期望间隔"的漂移。
 *
 * 漂移远大于期望间隔，说明这段时间主线程被同步工作占住（渲染风暴 / 长任务），
 * 这正是"整个窗口点不动"的机器可读证据。返回停止函数。
 */
export function startHeartbeat(label: string, intervalMs = 2000): () => void {
  let expected = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - expected;
    expected = now + intervalMs;
    diagTrail("heartbeat", {
      label,
      driftMs: drift,
      ...(drift > intervalMs ? { suspicion: "main-thread block" } : {}),
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * 渲染风暴检测：单位窗口内渲染次数超阈值就记一条（每窗口只记一次）。
 *
 * 为什么需要它：无限渲染循环会把主线程钉死，表现就是"窗口点不动"，而且**不产生任何控制台输出**
 * —— 唯一能抓到它的地方就是渲染函数自己。
 *
 * @returns 本窗口是否触发了记录
 */
export function noteRenderBurst(
  count: number,
  windowMs: number,
  threshold = 120,
): boolean {
  if (count < threshold) return false;
  diagTrail("render burst", { rendersInWindow: count, windowMs, threshold });
  return true;
}
