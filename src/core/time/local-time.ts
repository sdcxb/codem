/**
 * **本地时间的唯一口径**（`TIME-SINGLE-SOURCE` / `TIME-WINDOW-*` / `TIME-DST-*`）。
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
 * ## 日窗口（第 191 波 O-40：`now - i * 24h` **不是**本地日历日）
 *
 * 「按天分格/按天展示」曾经写成 `now - i * 24h` 到 `+24h`（`UsageChart` / `TokenActivityGrid`
 * / 图书馆热力图各写一份）。夏令时跳变日里本地日历日是 **23 或 25 小时** ⇒ 窗口边界与本地日 key
 * **错开 1 小时**：某天的记录被算进相邻格子，或某格少一小时的记录 —— 而「哪一天」的**格式**判据全绿
 * （它管 `localDateString()`，不管窗口**步长**）。
 *
 * 所以窗口**只能在本文件生成**：`localDayWindows()` 逐日按**本地日历日**推，
 * 每天的 `end` = **次日 `start`**（不是 `start + 24h`），相邻两日首尾相接、无缝隙、无重叠。
 * 判据 `TIME-WINDOW-1/2/3` + `TIME-DST-1/2/3` 钉这件事，`TIME-DST-4` 用解析式对账禁止
 * 别处再出现裸日长字面量（「经过时长」类必须逐条登记理由）。
 *
 * 偏移是**可注入**的（`OffsetMinutesOf`）：真实运行走 `systemOffsetMinutesOf`（系统时区），
 * 判据则注入 `America/New_York` 之类的**偏移表** ⇒ 确定性、不依赖进程 `TZ`、不影响别的测试文件。
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

/**
 * 「某个**瞬时**的时区偏移是多少分钟」——东为正。
 *
 * 这是本模块唯一的外部时区输入：生产环境用 `systemOffsetMinutesOf`（系统时区），
 * 判据注入固定表 ⇒ 同一份算法可以在**任意时区**下被确定性地验证（含 DST 跳变）。
 */
export type OffsetMinutesOf = (instantMs: number) => number;

/**
 * 缺省偏移口径：**系统时区**。
 *
 * 偏移与该瞬时来自同一个 `Date`（`getTimezoneOffset()` 是西为正，这里取反成东为正）。
 * 注意 DST 跳变时**偏移随瞬时变化**，所以本模块内部一律把它当**函数**用（而不是取一次的常量）。
 *
 * ⚠️ 第 191 波（O-51 棘轮收紧）：**不再导出** —— 它是本模块各函数的**缺省实参**，
 * 全仓没有外部 import（需要固定时区的判据自己注入偏移表，见 `time-window-dst.test.ts`）。
 */
const systemOffsetMinutesOf: OffsetMinutesOf = (instantMs) =>
  -new Date(instantMs).getTimezoneOffset();

/** 本地时间字段分解（**可注入偏移**；`instantMs` 是瞬时毫秒）—— 本仓唯一的"本地时分/年月日"算法 */
export function localTimePartsAt(
  instantMs: number,
  offsetMinutesOf: OffsetMinutesOf = systemOffsetMinutesOf,
): LocalTimeParts {
  const offsetMinutes = offsetMinutesOf(instantMs);
  // 本地墙上时间 = UTC 毫秒 + 偏移；再用 UTC 取值器读出来 ⇒ 就是本地字段
  const shifted = new Date(instantMs + offsetMinutes * 60_000);
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

/** 本地时间字段分解（本仓**唯一**的"本地时分/年月日"来源） */
export function localTimeParts(at: Date): LocalTimeParts {
  return localTimePartsAt(at.getTime());
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

// ===================== 本地日历日窗口（O-40 的唯一实现） =====================

/**
 * 一个**本地日历日**窗口，左闭右开 `[start, end)`。
 *
 * `end` **不是** `start + 24h`：夏令时跳变日里这一天是 23 或 25 小时，
 * `end` 取**次日本地日历日的 `start`** ⇒ 相邻窗口首尾相接、无缝隙、无重叠。
 */
export interface LocalDayWindow {
  /** 窗口起点瞬时：该本地日历日 00:00 对应的瞬时（边界见 `localDayStartMs`） */
  start: number;
  /** 窗口终点瞬时 = **次日**的 `start`（因此 `end - start` 可能是 23h / 24h / 25h） */
  end: number;
  /** 窗口起点的瞬时（与 `start` 同值；给「格子/柱子」直接当时间戳用，如 `TokenActivityGrid` 的 `cell.date`） */
  date: number;
}

/** 瞬时 → 该瞬时的**本地墙上时间**毫秒（墙上时间轴：日界恒为整日，不含 DST 语义） */
function wallClockMs(instantMs: number, offsetMinutesOf: OffsetMinutesOf): number {
  return instantMs + offsetMinutesOf(instantMs) * 60_000;
}

/**
 * 墙上时间毫秒 → 该墙上时间所在**墙上日**的零点。
 *
 * 用 UTC 字段拼 `Date.UTC(...)`（而不是减去 `24h` 的余数）⇒ 本文件里**不需要**任何裸日长常量。
 */
function wallDayStartOf(wallMs: number): number {
  const d = new Date(wallMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 墙上日的零点 ± `days` 天（用日历加法：`setUTCDate` 自动处理跨月/跨年，也不需要裸日长） */
function wallDayStartShift(wallDayStartMs: number, days: number): number {
  const d = new Date(wallDayStartMs);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getTime();
}

/**
 * 墙上日的零点（`wallDayStartMs`）→ 对应的**瞬时**。
 *
 * 换算关系是 `瞬时 = 墙上时间 - 偏移`，而 DST 跳变时**偏移随瞬时变化** ⇒ 必须迭代收敛：
 * 先按「墙上零点当瞬时」求一次偏移，再用**该猜测瞬时**的偏移修正一次（两次足够：
 * 偏移只会因一次跳变而变，第二遍一定落在跳变后的正确一侧）。
 *
 * **边界口径**：某些时区的跳变发生在**本地 00:00**（例如贝鲁特 2024-03-31 的 00:00 → 01:00、
 * 圣地亚哥 2024-09-08 的 00:00 → 01:00）。那时该日**不存在本地 00:00**，本函数按
 * **「该日实际最早的瞬时」**（= 跳变结束那一刻，本地时钟直接显示 01:00）处理 ——
 * 这样「窗口起点」仍然落在**正确的本地日历日**里，且与前一日的 `end` 严丝合缝相接。
 */
function wallDayStartToInstant(
  wallDayStartMs: number,
  offsetMinutesOf: OffsetMinutesOf,
): number {
  const first = wallDayStartMs - offsetMinutesOf(wallDayStartMs) * 60_000;
  const second = wallDayStartMs - offsetMinutesOf(first) * 60_000;
  // 收敛判据：候选瞬时的**本地墙上时间**是否已进入目标日。没进入 ⇒ 该日无本地 00:00，
  // 取那个已经进入目标日的候选（= 跳变结束那一刻 = 该日实际最早的瞬时）。
  return wallClockMs(second, offsetMinutesOf) >= wallDayStartMs ? second : first;
}

/**
 * **某个瞬时所在本地日历日的 00:00 对应的瞬时**（本仓唯一实现）。
 *
 * - 正常日：返回本地 00:00 的瞬时；
 * - 跳变吞掉本地 00:00 的日（见 `wallDayStartToInstant` 的边界口径）：返回该日**实际最早的瞬时**；
 * - `offsetMinutesOf` 可注入 ⇒ 判据能固定时区（含 DST 偏移表）复现，不依赖进程 `TZ`。
 */
export function localDayStartMs(
  atMs: number,
  offsetMinutesOf: OffsetMinutesOf = systemOffsetMinutesOf,
): number {
  return wallDayStartToInstant(wallDayStartOf(wallClockMs(atMs, offsetMinutesOf)), offsetMinutesOf);
}

/**
 * 从 `endAt` 所在的本地日历日起，**往前 `days` 个本地日历日**的窗口列表（旧的在前、今天的在最后）。
 *
 * 这是「按天分格/按天展示」的**唯一**步长实现：`UsageChart` / `TokenActivityGrid`
 * / 图书馆遥测热力图都从这里取格子，不许各自 `now - i * 24h`。
 *
 * 保证：
 * 1. 长度恒为 `days`（格子数 = 声明天数）；
 * 2. 相邻两日 `windows[k].end === windows[k + 1].start`（首尾相接、无缝隙、无重叠）；
 * 3. `localDateString(new Date(win.start))` 就是这一格代表的本地日历日。
 */
export function localDayWindows(
  days: number,
  endAt: Date | number = Date.now(),
  offsetMinutesOf: OffsetMinutesOf = systemOffsetMinutesOf,
): LocalDayWindow[] {
  const count = Math.max(0, Math.floor(days));
  const refMs = typeof endAt === "number" ? endAt : endAt.getTime();
  const todayWallStart = wallDayStartOf(wallClockMs(refMs, offsetMinutesOf));

  // bounds[k] = 「k - 1 天前」那一天的起点瞬时（k = 0 ⇒ 明天；k = 1 ⇒ 今天）
  const bounds: number[] = [];
  for (let k = 0; k <= count; k++) {
    bounds.push(wallDayStartToInstant(wallDayStartShift(todayWallStart, 1 - k), offsetMinutesOf));
  }

  const out: LocalDayWindow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // i 天前那一格 = [它的起点, 次日的起点) —— `end` 取次日的 start，而不是 `start + 24h`
    out.push({ start: bounds[i + 1], end: bounds[i], date: bounds[i + 1] });
  }
  return out;
}
