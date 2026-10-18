/**
 * 「移交到新对话」的**会话创建**逻辑（标题唯一化 + 创建 + 委派）。
 *
 * ## 真机缺陷（2026-10-18 用户直报，两条同源）
 *
 * 1. 用户让 agent 把任务「移交给新对话」，agent 却把它交给了**一个标题相似的老会话**。
 *    根因：跨会话工具只有 `delegate_to_session(target_session_id)`，**没有"新建会话"的能力**；
 *    agent 只能从 `list_sessions` 里挑一条 —— 而标题并不唯一（见下一条），于是一挑就错。
 * 2. 侧栏里反复出现同名「交接会话」，而且总被顶到最前（按更新时间排序）。
 *    根因：`WaterLevelBanner` 每次都 `createSession("交接会话")`，**标题没有任何区分**；
 *    多个同名会话并存，用户无法判断哪个是这次的、哪个是上次的。
 *
 * ## 本模块的两个职责
 *
 * - `nextHandoverTitle`：生成**可读且唯一**的标题（基础名 + 时间戳 + 冲突序号）；
 * - `openHandoverSession`：依赖注入的"创建新会话并委派"流程（store / 编排器由调用方传入，
 *   这样判据可以直接用替身测，不必拉起整个 Tauri 环境）。
 *
 * 判据 `HANDOFF-NEW-1..4`。
 */

/** 交接会话的基础名（中/英） */
import { localDateTimeString } from "../time/local-time";

export const HANDOVER_TITLE_ZH = "交接会话";
export const HANDOVER_TITLE_EN = "Handover session";

/**
 * 时间戳：`MM-DD HH:mm`（与侧栏其它条目的可读粒度一致）。
 *
 * ⚠️ 不许在这里自己算 `getMonth()/getHours()` —— 本项目有唯一时间口径
 * `core/time/local-time.ts`（判据 `TIME-SINGLE-SOURCE`），本地时间只从那里取。
 */
export function handoverStamp(now: Date = new Date()): string {
  // localDateTimeString → `YYYY-MM-DD HH:mm`；去掉年份即 `MM-DD HH:mm`
  return localDateTimeString(now, { seconds: false }).slice(5);
}

/**
 * 生成唯一标题：
 * - 未冲突 ⇒ `交接会话 · 10-18 10:30`
 * - 已冲突 ⇒ 追加 ` (2)` / ` (3)` …
 *
 * 注意：**唯一性是硬要求**，不是美观问题 —— 同名会话会让用户（和 agent）无法区分"这次的交接"
 * 与"上次的交接"，也正是真机上 agent 误投到老会话的土壤。
 */
export function nextHandoverTitle(
  existing: readonly string[],
  zh: boolean,
  now: Date = new Date(),
): string {
  const base = `${zh ? HANDOVER_TITLE_ZH : HANDOVER_TITLE_EN} · ${handoverStamp(now)}`;
  const taken = new Set(existing.map((t) => String(t ?? "")));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  // 极端情况（同一分钟内 1000 次交接）：加毫秒尾巴，仍然唯一
  return `${base} (${Date.now()})`;
}

export interface OpenHandoverSessionOptions {
  zh: boolean;
  /** 交接正文（应已通过 `checkHandover`；本函数不重复校验） */
  task: string;
  sourceSessionId: string;
  projectId: string;
  /** 当前作用域里已有会话的标题（用于避免重名） */
  existingTitles: readonly string[];
  /** 注入：创建会话（返回新会话对象；失败返回 null/undefined） */
  createSession: (title: string) => { id: string } | null | undefined;
  /** 注入：委派（返回任务 id） */
  delegate: (args: {
    sourceSessionId: string;
    targetSessionId: string;
    task: string;
    projectId: string;
  }) => Promise<{ id: string }>;
  /** 注入：时钟（测试可固定时间） */
  now?: Date;
  /**
   * 建会话的重试次数（默认 3）。
   *
   * 为什么要重试：交接的**目的是"到新对话去"** —— 建会话失败（同名冲突、存储抖动）时
   * 直接报错等于没完成目的，用户还得手动重来。这里**换一个标题重试**（标题带序号/时间戳），
   * 仍然**绝不**退化成"委派给某个已有会话"。
   */
  attempts?: number;
}

export interface OpenHandoverSessionResult {
  sessionId: string;
  title: string;
  delegationId: string;
}

/**
 * 创建**新**会话并把交接委派过去。
 *
 * 失败语义：
 * - 拿不到新会话 id ⇒ 抛错（调用方负责如实上报，**不许**退化成"委派到某个已有会话"）；
 * - 委派抛错 ⇒ 原样抛出（新会话已经建好，调用方要在错误里说明这一点）。
 */
export async function openHandoverSession(
  opts: OpenHandoverSessionOptions,
): Promise<OpenHandoverSessionResult> {
  const attempts = Math.max(1, Math.min(10, opts.attempts ?? 3));
  const tried: string[] = [];
  let lastError = "";
  let created: { id: string; title?: string } | null | undefined = null;
  let title = "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    title = nextHandoverTitle([...opts.existingTitles, ...tried], opts.zh, opts.now ?? new Date());
    tried.push(title);
    try {
      created = opts.createSession(title);
      if (created?.id) break;
      lastError = opts.zh ? "没有拿到会话 id" : "no session id returned";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e ?? "");
      created = null;
    }
    console.warn(`[handoff] 新建会话第 ${attempt + 1}/${attempts} 次失败（${title}）：${lastError}`);
  }

  if (!created?.id) {
    throw new Error(
      (opts.zh
        ? `新建会话失败（已换名字重试 ${attempts} 次：${tried.join(" / ")}；最后一次：${lastError}）`
        : `Failed to create the new session after ${attempts} attempts (${tried.join(" / ")}; last: ${lastError})`),
    );
  }
  const task = await opts.delegate({
    sourceSessionId: opts.sourceSessionId,
    targetSessionId: created.id,
    task: opts.task,
    projectId: opts.projectId,
  });
  if (!task?.id) {
    throw new Error(
      opts.zh
        ? `新会话已创建（${created.id}），但委派没有拿到任务 id`
        : `New session ${created.id} was created, but delegation returned no task id`,
    );
  }
  return { sessionId: created.id, title, delegationId: task.id };
}
