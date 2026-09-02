/**
 * 计划步骤工具函数（对标 dsh-desktop 客户端 todo_write 的"语义步骤 + 动态插入"模式）。
 *
 * Codem 对话的宏观步骤此前是"回答问题 / 执行命令"式通用标题，且不支持执行中
 * 插入新步骤（只能在计划耗尽后按执行工具类别尾部追加 ≤2 步）。本模块提供：
 *
 *   1. 任务意图检测：判断一条用户消息是否是需要"语义计划"的执行型任务
 *      （修复/排查/实现/重构……），而不是纯文本问答 —— 纯问答不该出现
 *      "第X步：回答问题"式的伪步骤。
 *   2. applyPlanUpdate：把模型通过 update_plan 工具发来的插入操作应用到
 *      当前计划（insert_before / insert_after / append），只允许插入到
 *      "当前进行中或更靠后"的位置（已完成步骤不可被改写），并做去重、
 *      标题长度、总步数上限校验。
 */

export interface StepPlan {
  title: string;
}

/** 计划总步数上限（防无限膨胀）。 */
export const MAX_PLAN_STEPS = 12;
/** 单个步骤标题最大长度。 */
export const MAX_STEP_TITLE_LENGTH = 80;

/** 模型通过 update_plan 工具提交的计划更新操作。index 省略时按当前进行中的步骤解析。 */
export type PlanUpdateOp =
  | { action: "insert_before"; index?: number; titles: string[] }
  | { action: "insert_after"; index?: number; titles: string[] }
  | { action: "append"; titles: string[] };

export type PlanUpdateResult =
  | { ok: true; items: StepPlan[]; message: string }
  | { ok: false; error: string };

/**
 * 中文/英文任务动词 —— 命中说明该消息是需要"执行/分析"的任务，而不是
 * 只需文本回答的闲聊或纯问题。
 */
const TASK_INTENT_RE = /(修复|解决|排查|调试|实现|开发|重构|优化|改进|升级|迁移|集成|搭建|配置|创建|编写|添加|删除|修改|测试|验证|编译|部署|分析|诊断|检查|报错|错误|异常|崩溃|卡死|失败|为什么|怎么回事|什么原因|怎么|如何|能否|能不能|帮忙|帮我看|处理|定位)/i;

/** 纯文本闲聊/问候词 —— 即便含个别动词也不应触发任务计划。 */
const CASUAL_RE = /^(你好|hi|hello|hey|谢谢|感谢|再见|拜拜|在吗|你是谁|你能做什么|介绍一下你自己|讲个笑话|哈哈|嗯|哦|好的|ok|yes|no)\b/i;

/**
 * 判断用户消息是否需要语义化计划（执行型任务）。
 * 纯文本问答返回 false —— 这类消息不应展示"第X步"计划。
 */
export function looksLikeExecutableTask(message: string): boolean {
  if (!message || message.trim().length === 0) return false;
  const msg = message.trim();
  if (CASUAL_RE.test(msg)) return false;
  // 英文动作词（read/write/run 等已在 estimateSteps 的 toolKeywords 覆盖，
  // 这里补中文任务意图 + 常见英文任务句）。
  if (TASK_INTENT_RE.test(msg)) return true;
  const lower = msg.toLowerCase();
  const enTaskWords = [
    "fix", "bug", "error", "crash", "implement", "refactor", "optimize",
    "debug", "migrate", "build", "test", "deploy", "analyze", "diagnose",
    "why is", "why does", "how to", "can you", "could you", "make ",
  ];
  return enTaskWords.some((w) => lower.includes(w));
}

/** 清洗单个标题：trim、截断、过滤空串。 */
function cleanTitle(raw: string): string {
  const t = raw.trim();
  return t.length > MAX_STEP_TITLE_LENGTH ? t.slice(0, MAX_STEP_TITLE_LENGTH) : t;
}

/**
 * 渲染"当前执行计划"上下文段（注入每次 LLM 请求的 systemPrompt）。
 *
 * 对标 dsh 客户端 todo：模型每轮都能看到任务列表与进行状态，才能在有意义
 * 的时机调用 update_plan 动态插入新步骤。无计划（纯问答）时返回空串。
 */
export function renderPlanSection(items: StepPlan[] | null | undefined, macroStep: number): string {
  if (!items || items.length === 0) return "";
  const lines = items.map((s, i) => {
    const num = i + 1;
    const state = num < macroStep ? "完成" : num === macroStep ? "进行中" : "待办";
    return `${num}. [${state}] ${s.title}`;
  });
  return (
    `当前执行计划（进行到第 ${Math.min(macroStep, items.length)}/${items.length} 步）。按顺序执行；` +
    `若发现必须先处理的新问题（例如当前修复依赖另一个问题），调用 update_plan 把新步骤插入到当前进行中的步骤之前，再继续。\n` +
    lines.join("\n")
  );
}

/**
 * 将模型提交的计划更新应用到当前计划。
 *
 * @param items 当前计划（1-based 语义：items[0] 是第 1 步）
 * @param op 更新操作
 * @param macroStep 当前进行中的步骤编号（1-based，已完成 = < macroStep）
 * @returns 应用后的新计划 + 给模型的结果文本；校验失败返回错误
 */
export function applyPlanUpdate(
  items: StepPlan[],
  op: PlanUpdateOp,
  macroStep: number,
): PlanUpdateResult {
  const titles = (op.titles ?? [])
    .map(cleanTitle)
    .filter((t) => t.length > 0);
  if (titles.length === 0) {
    return { ok: false, error: "update_plan: titles 为空或全部为空白。请提供至少一个非空步骤标题。" };
  }
  // 去重：与已有步骤标题（trim 后）重复的丢弃。
  const existing = new Set(items.map((i) => i.title.trim()));
  const fresh = titles.filter((t) => !existing.has(t.trim()));
  if (fresh.length === 0) {
    return { ok: false, error: "update_plan: 提供的步骤与计划中已有步骤重复，无需插入。" };
  }
  if (items.length + fresh.length > MAX_PLAN_STEPS) {
    return { ok: false, error: `update_plan: 插入后总步数 ${items.length + fresh.length} 超过上限 ${MAX_PLAN_STEPS}，请精简。` };
  }

  const next: StepPlan[] = [...items];
  let atIndex: number; // 0-based 插入位置
  let verb: string;

  switch (op.action) {
    case "insert_before": {
      // 缺省 index = 当前进行中的步骤（把新步骤插到当前步之前，编号顺延）。
      const target = Number.isFinite(op.index) ? Math.floor(op.index!) : macroStep;
      // 校验 index：1-based。只允许插入到"当前进行中或更靠后"的步骤之前
      // （已完成步骤是历史，不允许把新步骤插进已完成区段）。
      if (target < macroStep) {
        return {
          ok: false,
          error: `update_plan: insert_before 只能插入到当前进行中的第 ${macroStep} 步或之后（收到 index=${op.index}）。新发现的子问题应插入到当前步骤之前 —— 使用 index=${macroStep}。`,
        };
      }
      atIndex = Math.min(target - 1, next.length); // 超过末尾 → 追加
      verb = "插入";
      break;
    }
    case "insert_after": {
      // 缺省 index = 当前进行中的步骤（插到当前步之后）。
      const target = Number.isFinite(op.index) ? Math.floor(op.index!) : macroStep;
      if (target < macroStep - 1) {
        return {
          ok: false,
          error: `update_plan: insert_after 只能插入到第 ${macroStep - 1} 步（已完成的上一步）或更靠后的位置（收到 index=${op.index}）。`,
        };
      }
      atIndex = Math.min(target, next.length);
      verb = "插入";
      break;
    }
    case "append": {
      atIndex = next.length;
      verb = "追加";
      break;
    }
    default: {
      const _exhaustive: never = op;
      return { ok: false, error: `update_plan: 未知操作 ${JSON.stringify(op)}` };
    }
  }

  const inserted: StepPlan[] = fresh.map((title) => ({ title }));
  next.splice(atIndex, 0, ...inserted);

  const startNum = atIndex + 1;
  const summary = next
    .map((s, i) => `${i + 1}. ${s.title}`)
    .join("；");
  return {
    ok: true,
    items: next,
    message: `已${verb}步骤：${fresh.join("、")}（第 ${startNum}${fresh.length > 1 ? `-${startNum + fresh.length - 1}` : ""} 步）。当前计划共 ${next.length} 步：${summary}。请继续按计划执行。`,
  };
}
