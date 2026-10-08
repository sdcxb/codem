/**
 * **本地时间的唯一口径**（`TIME-SINGLE-SOURCE`）。
 *
 * ## 为什么要有这个模块（第 189 波 R7：同一簇的第三份）
 *
 * 「产出时间戳/日期」这件事在本仓曾经各有各的写法，已经连续出了三次**同一类**缺陷：
 *
 * | # | 位置 | 形态 | 后果 |
 * | --- | --- | --- | --- |
 * | 1 | `prompt.ts` 的 `# Current Date` | 取**本地**年月日时分，却硬编码 `Z` | 把本地时间谎称成 UTC（差 8 小时） |
 * | 2 | `llm/time-context.ts` 的时间戳 | 取 `toISOString()`（**UTC 数字**）再拼**本机偏移** | 标注的瞬时比真实早 8 小时，与同请求的 date 当场矛盾 |
 * | 3 | `memory.ts` 的 `safeDate()`（记忆行的 `[日期]`） | 取 `toISOString()` 切前 10 位 = **UTC 日** | `Asia/Shanghai` 本地 00:00–08:00 创建的条目显示**前一天** |
 *
 * 三次的根因是同一个：**"给人看的本地时间"被各处自己算了一遍**。所以这里只留一处算法，
 * 其它模块一律从这里取（判据 `TIME-SINGLE-SOURCE` 用解析式对账钉住：
 * `getTimezoneOffset()` / `getFullYear()` / `toISOString().split("T")` 这类自造格式化
 * **只允许出现在本文件**，例外必须登记在判据的 allowlist 里并写明理由）。
 *
 * ## 算法（一处）
 *
 * **本地字段 = `UTC 毫秒 + 偏移` 的 UTC 字段**，偏移与字段来自**同一个 `Date`** ——
 * 数学上与 `getHours()` 等价（真实时区下逐字节相同），但让"固定时区"成为**可注入、可测**的输入
 * （判据 `TIME-CTX-1` 就把 `getTimezoneOffset()` 固定成 `-480` 来钉"解析回的瞬时 == 输入瞬时"）。
 *
 * `offsetMinutes` 东为正（与 `getTimezoneOffset()` 反号）。
 *
 * ## 与"机器用的瞬时"的分界
 *
 * 本模块**只**服务"给人看的时间"。日志/导出元数据/协议字段要的是**瞬时**，仍应写 UTC 的
 * `toISOString()`（而且**不许**再出现"UTC 数字 + 本地偏移"这种混搭 —— 那正是 #2 的形态）。
 */
export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 本机本地时区偏移（分钟，**东为正**）—— 与上面各字段来自同一个 `Date` */
  offsetMinutes: number;
}

/** 本地时间字段分解（本仓**唯一**的"本地时分/年月日"来源） */
export function localTimeParts(at: Date): LocalTimeParts {
  const offsetMinutes = -at.getTimezoneOffset();
  // 本地墙上时间 = UTC 毫秒 + 偏移；再用 UTC 取值器读出来 ⇒ 就是本地字段
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
    offsetMinutes,
  };
}

/** 偏移（分钟，东为正）→ `±HH:MM`（`-0` 也写成 `+00:00`） */
export function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${sign}${oh}:${om}`;
}

/** 两位补零（本模块内部用；对外不必暴露） */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * **本地日期** `YYYY-MM-DD`。
 *
 * ⚠️ 这是记忆行 `[日期]`、导出文件名、按天聚合的键等处**唯一**允许的"取哪一天"口径
 * （旧写法 `toISOString().split("T")[0]` 取的是 **UTC 日** ⇒ 本地 00:00–08:00 差一天）。
 */
export function localDateString(at: Date): string {
  const p = localTimeParts(at);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** **本地日期时间** `YYYY-MM-DD HH:mm[:ss]`（给人看的紧凑形态；`seconds` 默认 true） */
export function localDateTimeString(at: Date, opts?: { seconds?: boolean }): string {
  const p = localTimeParts(at);
  const clock = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${opts?.seconds === false ? clock : `${clock}:${pad2(p.second)}`}`;
}

/** **本地时分** `HH:mm[:ss]`（列表/日志行的时间列；`seconds` 默认 true） */
export function localClockString(at: Date, opts?: { seconds?: boolean }): string {
  const p = localTimeParts(at);
  const clock = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return opts?.seconds === false ? clock : `${clock}:${pad2(p.second)}`;
}
