/**
 * 交接协议（第 63 波）—— 「把会话交给另一个会话」时到底该传什么。
 *
 * 为什么需要它（第 62 波事故的**根因**，守卫只是安全网）：
 *   用户做了会话交接：父会话写了一份总结文件、再把任务 `delegate_to_session` 给新会话。
 *   新会话拿到的却是一段**自由生成的、几千字的"意图复述"** —— 里面全是"梳理项目背景 / 确认最终版本 /
 *   统一归档位置"这种**意图**，没有"文件在哪、已经产出什么、什么算做完"这类**状态**。
 *   于是新会话只能从零开始**重新遍历文件系统**，几十次目录枚举换来的是同一个列表，
 *   最后卡死（父会话那边还在无限期等它）。
 *
 * 三条规矩（本模块负责机械校验，提示词负责告诉模型怎么填）：
 *   1. **状态优先于意图**：必须给出「已完成产物」的**绝对路径**，而不是描述要做什么；
 *   2. **必须有完成判据**：说不出"什么算做完"，模型就没有终止条件，只能一直试探；
 *   3. **必须有预算**：交接正文有字数上限，超出的细节留在文件里、正文只放摘要 + 路径；
 *      并明确写"不要重新扫描目录"。
 *
 * 校验是**机械**的（不靠模型自觉）：缺项/超长就返回可读的错误，让父会话改写后重试。
 */

/** 交接正文的软上限：超过就要求改成"摘要 + 文件路径" */
export const HANDOVER_SOFT_LIMIT = 4000;
/** 硬上限：超过直接拒绝（几千字的"交接"就是从没有上限开始的） */
export const HANDOVER_HARD_LIMIT = 12000;
/** 路径必须以盘符/UNC/根斜杠开头才算"绝对路径"（Windows + POSIX 都认） */
const ABSOLUTE_PATH_RE = /(?:[a-zA-Z]:[\\/]|\\\\|\/(?:home|Users|mnt|opt|var|tmp|workspace|root)\/)/;
/**
 * 退一步的"具体目标"：**带扩展名的文件名**（含相对路径写法）。
 *
 * 为什么要有这一档：绝对路径是**首选**，但"去跑 tests/test_x.py"、"更新 README.md" 这类交接
 * 指向的是明确的具体对象，不该被判成"没有指针"。判据放宽一档，误拒就少一截；
 * 真正要拦的是"只有意图、没有任何具体对象"的那种交接。
 */
const CONCRETE_TARGET_RE =
  /[\w\u4e00-\u9fa5@.-]+\.(md|markdown|txt|docx?|xlsx?|pptx?|pdf|json|ya?ml|toml|ini|csv|log|ts|tsx|jsx?|mjs|cjs|py|ps1|sh|bash|bat|cmd|html?|css|scss|sql|go|rs|java|kt|c|cc|cpp|h|rb|php|swift)\b/i;

export interface HandoverCheck {
  ok: boolean;
  /** 面向模型的错误说明（ok=false 时给出改写指引） */
  error?: string;
  /** 面向模型的提醒（ok=true 时可能仍有改进项，例如正文偏长） */
  warning?: string;
  /** 机械量到的信息，用于日志/测试 */
  stats: {
    chars: number;
    hasAbsolutePath: boolean;
    hasPointer: boolean;
    hasDoneCriteria: boolean;
    /** 第 65 波：判据是否**可判定**（含路径/命令/可比的量，而不只是"完成判据"四个字） */
    hasCheckableCriterion: boolean;
    hasNoRescan: boolean;
  };
}

/** 完成判据的候选说法（中英）—— 只要有其一即视为写了"什么算做完" */
const DONE_CRITERIA = [
  "完成判据",
  "验收标准",
  "验收判据",
  "交付物",
  "交付标准",
  "definition of done",
  "acceptance criteria",
  "deliverable",
];
/** "不要重新扫描"的候选说法 */
const NO_RESCAN = ["不要重新扫描", "无需重新扫描", "不要重复扫描", "不必重新枚举", "不要遍历", "do not re-scan", "do not rescan", "don't rescan"];

/**
 * 第 65 波（L0）：判据必须是**可判定**的，不能只是出现"完成判据"四个字。
 *
 * 为什么：第 62 波的事故根因是"交接只写意图、不写状态"。第 63 波加了关键词校验，
 * 但"完成判据：全部完成"这种空话也能过 —— 接收方拿不到任何可检查的东西，于是继续瞎找。
 * 现在要求判据句里必须出现**可检查的对象**之一：
 *   · 一个路径/文件名（带扩展名）—— "产出 D:\x\3000字版.docx"；
 *   · 一个反引号包裹的命令/断言 —— "`pytest tests/x.py` 通过"；
 *   · 一个可比的量 —— "正文 2900–3100 字"、"≥ 3 个章节"、"通过率 100%"。
 * 仍然是启发式（换说法可能绕过），所以校验**会放手**（见 tools.ts 的 failOpen）——
 * 它的作用是"把最差的那种交接拦下来"，不是当门神。
 */
const CHECKABLE_CRITERION =
  /([\w\u4e00-\u9fa5@.-]+\.(md|markdown|txt|docx?|xlsx?|pptx?|pdf|json|ya?ml|ts|tsx|jsx?|py|ps1|sh|log|csv|html?|css|sql)\b)|(`[^`\n]{3,}`)|((\d+\s*[-–~至到]\s*\d+)|(≥|<=|>=|大于|小于|不少于|不超过|至少|至多)\s*\d+|\d+\s*(个|条|行|字|项|章节|%))/;

/**
 * 校验一段交接正文是否合格。
 *
 * 注意判据是"**机械可判**"的：绝对路径用正则、完成判据/禁止重扫用关键词。
 * 关键词判据天然会被"换个说法"绕过 —— 这是有意的取舍：宁可放过，也不要把
 * 正常表述判错然后拦住用户的工作。真正的约束来自提示词模板，这里只兜住最差的情况。
 */
export function checkHandover(task: string): HandoverCheck {
  const text = task ?? "";
  const chars = text.length;
  // 判据行：包含"完成判据/验收标准/交付物"等字样的那些行 —— 只有这些行才需要"可判定"
  const criteriaLines = text
    .split(/\r?\n/)
    .filter((line) => DONE_CRITERIA.some((k) => line.toLowerCase().includes(k.toLowerCase())));
  const stats = {
    chars,
    hasAbsolutePath: ABSOLUTE_PATH_RE.test(text),
    hasPointer: ABSOLUTE_PATH_RE.test(text) || CONCRETE_TARGET_RE.test(text),
    hasDoneCriteria: criteriaLines.length > 0,
    // 可判定 = 判据行里出现了路径/命令/可比的量；或者全文里"完成判据："后面的内容足够具体
    hasCheckableCriterion: criteriaLines.some((line) => CHECKABLE_CRITERION.test(line)),
    hasNoRescan: NO_RESCAN.some((k) => text.toLowerCase().includes(k.toLowerCase())),
  };

  if (chars > HANDOVER_HARD_LIMIT) {
    return {
      ok: false,
      stats,
      error:
        `交接正文 ${chars} 字，超过硬上限 ${HANDOVER_HARD_LIMIT} 字。\n` +
        `**不要把全部上下文塞进交接正文**：把细节写进文件（例如 <工作目录>/对话交接总结.md），` +
        `正文只保留「摘要 + 该文件的绝对路径 + 下一步动作 + 完成判据」。\n` +
        `正文过长会让接收方丢失重点，并且它仍然会去重新遍历目录。`,
    };
  }

  const missing: string[] = [];
  if (!stats.hasPointer) {
    missing.push("「已完成产物 / 具体目标」的**绝对路径**（例如 D:\\proj\\对话交接总结.md）—— 接收方据此直接 read，而不是重新枚举目录");
  }
  if (!stats.hasDoneCriteria) {
    missing.push("**完成判据**（写明「什么算做完」，可用「完成判据 / 验收标准 / 交付物」等字样引出）—— 没有它接收方没有终止条件");
  } else if (!stats.hasCheckableCriterion) {
    // 第 65 波（L0）：有"完成判据"字样但判据本身不可判定 —— 这是"接收方继续瞎找"的典型来源
    missing.push(
      "**可判定的完成判据**：现在写的判据无法被检查（例如「全部完成」）。请给出其中之一：\n" +
        "      · 一个会存在的文件（带扩展名，如 `…\\3000字版.docx`）；\n" +
        "      · 一条能跑的命令/断言（用反引号包起来，如 `` `pytest tests/x.py` 通过 ``）；\n" +
        "      · 一个可比的量（如「正文 2900–3100 字」「≥ 3 个章节」「通过率 100%」）",
    );
  }

  if (missing.length > 0) {
    return {
      ok: false,
      stats,
      error:
        `交接正文缺少必需内容：\n  - ${missing.join("\n  - ")}\n\n` +
        `交接的正确形态是「**状态 + 指针**」，不是「意图复述」：\n` +
        `  1. 目标（一句话）\n` +
        `  2. 已完成产物：绝对路径 + 一句话说明\n` +
        `  3. 关键决定与约束（不要重复踩坑）\n` +
        `  4. 当前卡点（如果有）\n` +
        `  5. 下一步动作（可执行）+ **完成判据**\n` +
        `  6. 禁止事项：不要重新扫描目录、不要重复枚举\n` +
        `请改写后重新调用 delegate_to_session。`,
    };
  }

  const warning =
    chars > HANDOVER_SOFT_LIMIT
      ? `交接正文 ${chars} 字偏长（软上限 ${HANDOVER_SOFT_LIMIT}）。建议把细节落到文件里，正文只留摘要 + 路径。`
      : undefined;

  return { ok: true, stats, warning };
}

/** 提示词里给模型看的模板（与校验规则一一对应，避免"说要写却不给形状"） */
export const HANDOVER_TEMPLATE = `【会话交接】
1. 目标：<一句话说清要达成什么>
2. 已完成产物（绝对路径 + 说明）：
   - <绝对路径>：<这是什么/做到哪一步>
3. 关键决定与约束：<已经定下来的事、不要推翻的结论、踩过的坑>
4. 当前卡点（若有）：<卡在哪、试过什么>
5. 下一步动作（可执行，含完成判据）：
   - <动作> → 完成判据：<**可判定**的东西：会存在的文件 / 能跑的命令 / 可比的量>
6. 禁止事项：不要重新扫描目录或重复枚举文件；需要文件内容时直接用上面的绝对路径 read。

（"完成判据"必须是别人能**检查**的：例如「产出 D:\\x\\3000字版.docx 且正文 2900–3100 字」、
 「\`pytest tests/x.py\` 全绿」—— 不要写"全部完成"这种没法验证的话。）`;
