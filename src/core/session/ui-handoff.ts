/**
 * UI 触发的**会话交接**（第 122 轮）—— 「开启新对话」不是"从零开始"，而是"把当前工作交出去"。
 *
 * ## 为什么需要这个模块
 *
 * 上下文满了以后，用户面前只有两条路，而两条路的代价完全不同：
 * - **压缩**：保留一份摘要 + 最近若干条，同一个会话继续（老对话细节变成摘要）；
 * - **开启新对话**：拿到一个干净窗口，但**全部上下文归零** —— 新会话不知道改过哪些文件、
 *   定过什么结论、卡在哪。
 *
 * 第 122 轮把两条路的提示做成常驻可见，并且给"开启新对话"接上平台**本来就有**的
 * 会话交接能力（第 62/63/65 波：`handover.ts` 校验 + `orchestrator.delegate` +
 * `executor.executeSessionTurn` + `delegated-turn-persistence`）。
 *
 * ## 为什么交接正文由**代码**生成，而不是让模型写
 *
 * 第 62 波事故的根因就是"交接正文由模型自由生成"：模型写了几千字的**意图复述**
 * （"梳理背景 / 确认版本 / 统一归档位置"），没有任何**状态**（文件在哪、做到哪、
 * 什么算做完），接收方只能从零重扫目录，几十次枚举后卡死。
 *
 * 所以第 63 波起有机械校验（`checkHandover`：必须绝对路径 + 必须有可判定的完成判据 +
 * 禁止重扫）。**让模型去满足一个机械校验是绕远路**：这里要传的事实
 * （用户请求、AI 结论、工具调用与结果、涉及文件、错误、待办）在消息库里**已经全都有了**，
 * `renderStructuredHistorySummary` 本来就是按这些段渲染的（第 47 轮 P2-D8，
 * 手动压缩与自动路径共用）。于是：
 *
 * 1. 用既有渲染器产出结构化摘要 → 充入交接模板的主体；
 * 2. 「已完成产物」段只写**磁盘上确实存在**的路径（由调用方注入的检查器逐条核，
 *    不是 `node:fs` —— 那个在浏览器里恒返回 false，见 `ExistsChecker`）；
 * 3. 完成判据一律是**可判定的**（「以 <绝对路径> 为交付物」——该路径经正则与存在性双重核对）；
 * 4. 第 6 条固定写"不要重新扫描目录"。
 *
 * 第 2/3 条是关键：交接里写一个**不存在**的路径，比不写路径更坏 —— 接收方 read 失败后
 * 会开始瞎找。所以宁可退到"以工作目录为交付物"，也不写没核过的路径。
 *
 * ## 诚实边界
 *
 * 这段交接是**机械摘要**，不是"模型对全局的理解"。所以正文里如实写明
 * 「本交接由平台机械生成」——接收方据此知道哪些是需要自己核实的，而不是把它当成
 * 上一轮模型的确认结论。**不知道下一步要做什么时就不编**（见 `nextStepLine`）。
 */
import type { ToolCall } from "../../store";
import { renderStructuredHistorySummary } from "../llm/compaction-budget";
import { checkHandover } from "./handover";

/** 只在「已完成产物」段露出的工具（只有它们真的产生了磁盘上的东西） */
const PRODUCING_TOOLS = new Set(["write", "edit", "multi_edit"]);
/** 参与"涉及路径"抽取的工具（读也算：它是已核实存在的工作对象） */
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "multi_edit", "glob", "grep", "bash", "notebook_edit"]);

/** 交接正文里"已完成产物"最多列几个路径（多了接收方也不会逐个读） */
const MAX_PRODUCT_PATHS = 8;
/** 交接正文引用"最近 N 条消息"（与手动压缩的保留集同量级） */
const RECENT_MESSAGE_LIMIT = 60;

export interface HandoverFacts {
  /** 交接正文（可直接作为 `delegate` 的 `task`） */
  body: string;
  /**
   * 第 2 条「已完成产物」里写的路径 —— **本会话真的写出来过**、且磁盘上仍在。
   *
   * 与 `verifiedPaths` 的区别是本轮实测逼出来的（见 UH-4）：`verifiedPaths` 曾经
   * 把"产出"和"涉及"混成一个字段，于是**写失败**的文件也会出现在"已完成产物"里。
   * 两个语义不能共用一个名字。
   */
  producedPaths: string[];
  /** 正文第 2 条会展示的全部路径（产出 ∪ 涉及，都已核实存在） */
  verifiedPaths: string[];
  /** 正文里提到的"主要交付物"路径（完成判据指向它） */
  primaryPath: string | null;
  /** 最近一次写操作的目标（用于挑主要交付物） */
  lastProducedPath: string | null;
  /** `checkHandover` 的结果（调用方据此决定是否还要给模型一次机会） */
  check: ReturnType<typeof checkHandover>;
  /**
   * 工作目录的**诊断事实**（哪个候选拿到了、用户主目录存不存在、最后用了哪个）。
   *
   * 为什么值得留在契约里：这个字段是"真机上交接被拒"定位过程中的唯一抓手。
   * 第一次修完（退到用户主目录）在单元测试里全绿，真机仍然被拒 ——
   * 如果当时只能看到 `check.ok === false`，就又要靠猜。留着它，
   * 下一次同类问题可以直接在 advisory 里读出"是哪个候选没通过"。
   */
  cwdProbe: {
    /** 调用方给的 cwd（原始值，可能是空串） */
    given: string;
    /** 解析到的用户主目录 */
    home: string;
    /** 该主目录是否通过存在性检查（`"THREW"` 表示检查器本身抛错） */
    homeExists: boolean | "THREW";
    /** 最终采用的目录；null 表示没有任何候选可用 */
    effective: string | null;
  };
}

/** 从工具入参里抽绝对路径（Windows 盘符 / UNC / POSIX 根） */
function absPathsFromArgs(args: unknown): string[] {
  let text = "";
  if (typeof args === "string") text = args;
  else if (args && typeof args === "object") {
    // 只取"路径形状"的字段，避免把文件**内容**里的路径当成目标
    const rec = args as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["file_path", "path", "filePath", "target", "notebook_path", "cwd", "command", "pattern"]) {
      const v = rec[key];
      if (typeof v === "string") parts.push(v);
    }
    text = parts.join("\n");
  }
  if (!text) return [];
  const out: string[] = [];
  // 盘符绝对路径（含空格前截断）；命令里的引号路径也命中
  const re = /(?:[a-zA-Z]:[\\/][^\s"'`|><)*?,;]*)|(?:\\\\[^\s"'`|><)*?,;]+)/g;
  for (const m of text.matchAll(re)) {
    const p = m[0].replace(/[.。，,;；:：]+$/, "");
    if (p.length > 3) out.push(p);
  }
  return out;
}

/** 路径看起来像"文件"（带扩展名）而不是目录 */
const looksLikeFile = (p: string): boolean => /\.[A-Za-z0-9]{1,8}$/.test(p);

/**
 * 校验"这个路径存在吗"的**必填检查器**。
 *
 * ## 为什么必须由调用方给（这一段是真机上的一次事故换来的）
 *
 * 第一版直接用 `import { existsSync } from "node:fs"`。它在 Vitest 里工作得很好
 * （Node 有真 `fs`），但**在装机版里恒为 `false`** —— 因为浏览器侧 `node:fs` 被
 * `vite.config.ts` 的 alias 换成了 `src/stubs/node-fs-stub.ts`，而那文件里
 * `existsSync` 是 `() => false`。
 *
 * 后果：`verifiedPaths` 永远为空、`primaryPath` 永远为 null ⇒ 交接正文永远没有
 * 绝对路径 ⇒ 协议校验永远拒绝 ⇒ **「开启新对话」这个功能在真机上完全不可用**，
 * 而单元测试全绿（它们跑在 Node 上）。
 *
 * 真机诊断把它钉死了（提示条上印出来的原文）：
 * ```
 * ［cwd="C:\\Users\\abee\\AppData\\Roaming\\com.codem.app\\workspace\\" home="" homeExists=false effective=null］
 * ```
 * cwd 明明是**真实存在**的目录，而 `homeExists` 也是 `false`（不是抛错）——
 * 说明 `existsSync` 在正常返回，只是永远返回 false。
 *
 * 所以检查器**没有默认值**（`exists?` 后来去掉了）：生产代码不该有机会"忘了传"
 * 而拿到一个不会回答的实现。生产走 `core/file-api.ts` 的 `exists()`（真机是 Tauri IPC），
 * 测试显式传同步实现。这条约定由 `renderer-standin-guards.test.ts` 的 STUB-* 判据守着。
 */
export type ExistsChecker = (path: string) => boolean | Promise<boolean>;

/**
 * 构造一次会话交接。
 *
 * @param messages 已按时间升序排列的会话消息（可见消息即可）
 * @param opts.cwd 工作目录（所有路径都核不到时的退路，必须是绝对路径）
 * @param opts.goal 当前活跃目标的标题（有就写进"目标"段，没有就如实说没有）
 * @param opts.exists 存在性检查器（**必填**：生产传运行时的那个，见 `ExistsChecker` 的事故说明）
 */
export async function buildHandover(
  messages: Array<{ role?: string; content?: unknown; toolCalls?: ToolCall[] }>,
  opts: { cwd: string; goal?: string; exists: ExistsChecker },
): Promise<HandoverFacts> {
  const exists = opts.exists;
  const recent = messages.slice(-RECENT_MESSAGE_LIMIT);
  const summary = renderStructuredHistorySummary(recent as never[]);

  // ---- 1. 收集候选路径，分「产出」与「涉及」两档 ----
  const produced: string[] = [];
  const touched: string[] = [];
  let lastProducedPath: string | null = null;

  for (const msg of recent) {
    for (const tc of msg.toolCalls ?? []) {
      const tool = String(tc?.tool ?? "");
      if (!PATH_BEARING_TOOLS.has(tool)) continue;
      // 失败的工具调用不算"产物"（写失败/编辑失败留下的是残骸，不是交付物）
      const failed = tc?.status === "error";
      for (const p of absPathsFromArgs(tc?.args)) {
        if (PRODUCING_TOOLS.has(tool) && !failed) {
          if (!produced.includes(p)) produced.push(p);
          lastProducedPath = p;
        }
        if (!touched.includes(p)) touched.push(p);
      }
    }
  }

  // ---- 2. 逐条核实存在性（没核过的一律不写进交接）----
  /**
   * 用**注入的检查器**，而不是 `node:fs`。理由见 `ExistsChecker` 的事故说明：
   * 浏览器里 `node:fs` 是恒返回 false 的桩，用它会让整份交接永远没有路径可指。
   */
  const verify = async (list: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const p of list) {
      try {
        if (await exists(p)) out.push(p);
      } catch {
        /* 单条核不了就当它不存在（宁可不写，也不写没核实的路径） */
      }
    }
    return out;
  };

  const producedOk = await verify(produced);
  const touchedOk = (await verify(touched)).filter((p) => !producedOk.includes(p));
  const verifiedPaths = [...producedOk, ...touchedOk].slice(0, MAX_PRODUCT_PATHS);

  // ---- 3. 主要交付物：最近一次真实写出、且**仍在磁盘上**的文件；否则退到工作目录 ----
  /**
   * ⚠️ 这里必须能退到工作目录。第一版只按"产出的文件"挑，于是**没写过文件**的会话
   * （纯问答、纯阅读、分析型任务）会落进"没有可核实路径"的分支，而那条分支的完成判据
   * 写成「先向用户确认路径再推进」—— 它**不含任何可检查对象**，
   * 于是 `checkHandover` 判 `hasCheckableCriterion: false`、整份交接被拒。
   *
   * 实测确认（真跑一次 `buildHandover`）：`check.ok = false`，
   * 报「可判定的完成判据：现在写的判据无法被检查」⇒「开启新对话」这个按钮
   * 在**所有没有产出文件的会话里**都会失败。这条是被探针抓出来的，不是推理出来的。
   *
   * 工作目录是**已核实存在**的绝对路径，写进完成判据既真实又可判定
   * （接收方就在这个目录里干活，"以此为根产出目标文件"是能检查的）。
   *
   * ## 真机抓到的第二个洞：**全局对话没有工作目录**
   *
   * 上面那条修完之后单元测试全绿，但在装机版上点「开启新对话（交接当前工作）」
   * **仍然被拒**，原因（advisory 里的原文）：
   *
   * > 交接正文缺少必需内容： - 「已完成产物 / 具体目标」的**绝对路径** …
   *
   * 复现出来是 `cwd = ""`（**全局对话**：`currentProject` 为 null）以及
   * `cwd` 指向一个不存在的目录这两种情况 ⇒ `primaryPath = null` ⇒ 无路径可指。
   * 也就是说：**"没有项目的对话"这个最常见的场景，交接必然失败** ——
   * 而单元测试用的是 `mkdtempSync` 出来的真实临时目录，**它永远看到绿**。
   *
   * 修法：把"工作目录"解析成**第一个真实存在的绝对路径**：
   * 「调用方给的 cwd → 用户主目录」。用户主目录几乎总在，于是这条路径不可能为空。
   *
   * ## 真机抓到的第三个洞（也是最后真正的那个）：**`node:fs` 在浏览器里是桩**
   *
   * 上面两条修完之后真机**仍然被拒**，而诊断印出来的是：
   * ```
   * ［cwd="C:\\Users\\abee\\AppData\\Roaming\\com.codem.app\\workspace\\" home="" homeExists=false effective=null］
   * ```
   * cwd 明明是**真实存在**的目录，`existsSync` 却说它不存在 —— 因为浏览器侧的
   * `node:fs` 被 alias 成桩、`existsSync` 恒返回 false（详见 `ExistsChecker` 的说明）。
   * 所以这一条不是"目录找错了"，而是"**我们根本没有在问一个会回答的人**"。
   */
  const firstExistingDir = async (candidates: Array<string | undefined>): Promise<string | null> => {
    for (const c of candidates) {
      if (!c) continue;
      try {
        if (await exists(c)) return c;
      } catch {
        /* 不可访问的候选跳过，继续下一个 */
      }
    }
    return null;
  };
  const homeDir =
    (typeof process !== "undefined" && (process.env?.USERPROFILE || process.env?.HOME)) || "";
  const effectiveCwd = await firstExistingDir([opts.cwd, homeDir]);
  /**
   * 诊断用：把"这次拿到了什么候选、哪个通过了存在性检查"如实挂在返回值上。
   * 真机上必须能看出**是哪个候选失败了**，否则只能一次次猜（这件事上我猜了三轮）。
   * 它是只读事实，不参与任何决策。
   */
  let homeExists: boolean | "THREW" = false;
  try {
    homeExists = homeDir ? await exists(homeDir) : false;
  } catch {
    homeExists = "THREW";
  }
  const cwdProbe: HandoverFacts["cwdProbe"] = {
    given: opts.cwd || "",
    home: homeDir,
    homeExists,
    effective: effectiveCwd,
  };

  const primaryCandidates = [
    lastProducedPath && producedOk.includes(lastProducedPath) ? lastProducedPath : null,
    producedOk.find(looksLikeFile) ?? null,
    producedOk[0] ?? null,
    effectiveCwd,
  ].filter((p): p is string => Boolean(p));
  const primaryPath = primaryCandidates[0] ?? null;

  // ---- 4. 组装正文（严格按 HANDOVER_TEMPLATE 的六段，见 handover.ts）----
  const userRequests = recent.filter((m) => m.role === "user").map((m) => String(m.content ?? "").trim()).filter(Boolean);

  const goalLine = opts.goal?.trim()
    ? opts.goal.trim()
    : userRequests.length > 0
      ? `继续完成最近一次用户请求：${userRequests[userRequests.length - 1].slice(0, 200)}`
      : "（本会话没有活跃目标记录，接收方应先向用户确认要做什么）";

  const productLines =
    producedOk.length > 0
      ? producedOk.slice(0, MAX_PRODUCT_PATHS).map((p) => `   - ${p}：本会话中由工具写出/修改过的文件`).join("\n")
      : touchedOk.length > 0
        ? touchedOk
            .slice(0, MAX_PRODUCT_PATHS)
            .map((p) => `   - ${p}：本会话读过/分析过的工作对象（**未被本会话修改**，内容以磁盘为准）`)
            .join("\n")
        : "   - （本会话没有留下可核实的文件路径；下一步的完成判据指向工作目录，见第 5 条）";

  /**
   * 完成判据：**必须是可判定的**。
   * `primaryPath` 的最后一档是**已核实存在的工作目录**，所以这句里一定出现一个绝对路径
   * —— `CHECKABLE_CRITERION` 的第一支（带扩展名的文件名）或路径判据。
   * `primaryPath` 为 null 只可能发生在"工作目录也不存在"这种环境下，那时如实说明。
   */
  let doneCriteria: string;
  if (!primaryPath) {
    doneCriteria =
      "   - 接收方先向用户确认交付物路径，再按该路径推进（本会话没有留下可核实的路径，且工作目录不可用）";
  } else if (looksLikeFile(primaryPath)) {
    doneCriteria =
      `   - 以 ${primaryPath} 为交付物继续推进（该文件已核实存在，可直接 read）` +
      " → 完成判据：该文件按上面第 1 条的目标更新完毕";
  } else {
    doneCriteria =
      `   - 在 ${primaryPath} 下产出目标交付物（工作目录已核实存在）` +
      ` → 完成判据：${primaryPath} 下出现承载第 1 条目标的文件`;
  }

  /**
   * 第 6 条的落点必须**跟着第 2 条的实际内容走**：第 2 条只有文件路径时指向它，
   * 否则指向第 5 条的完成判据（那里一定有绝对路径）。指错一节会让接收方以为
   * "上面第 2 条有路径"，然后在空列表上反复找。
   */
  const noRescanTarget = verifiedPaths.length > 0 ? "上面第 2 条的绝对路径" : "上面第 5 条的绝对路径";

  /**
   * 「路径都经核实」这句话**只在真的有路径时才能说**。
   * 第 2 条为空时，第 5 条引用的路径来自摘要（原始事实），**没有**经过存在性核实 ——
   * 把它说成"已核实"就是在交接里写假话，而接收方据此 read 失败后会开始瞎找
   * （那正是第 62 波事故的行为形态）。
   */
  const pathClaim =
    verifiedPaths.length > 0
      ? "所有路径都经磁盘存在性核实。"
      : "本会话没有留下可核实的文件路径；下面摘要里出现的路径是**原始事实，未经核实**，read 失败时如实报告、不要转而遍历目录。";

  const body = `【会话交接】

> 本交接由平台在会话上下文接近上限时**机械生成**（不是上一轮模型的总结），
> 事实来源：本会话最近 ${recent.length} 条消息的工具调用与结果；${pathClaim}
> 需要判断「这些结论是否仍然成立」时，请直接 read 上面给出的路径，而不是重新遍历目录。

1. 目标：${goalLine}

2. 已完成产物（绝对路径 + 说明）：
${productLines}

3. 关键决定与约束：
   以下是本会话的结构化摘要（含工具调用三段：名字 / 参数 / 结果）——
   其中的结论按「当时的状态」理解（这份交接是机械摘要，不是模型的复盘）：
${indent(summary, "   ")}

4. 当前卡点（若有）：见摘要的「错误」段；没有「错误」段即本会话未记录到失败。

5. 下一步动作（可执行，含完成判据）：
${doneCriteria}

6. 禁止事项：不要重新扫描目录或重复枚举文件；需要文件内容时直接用${noRescanTarget} read。
`;

  return {
    body,
    producedPaths: producedOk,
    verifiedPaths,
    primaryPath,
    lastProducedPath,
    cwdProbe,
    check: checkHandover(body),
  };
}

/** 给多行文本统一加前缀（保持摘要的段落结构不丢） */
function indent(text: string, prefix: string): string {
  return String(text ?? "")
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}
