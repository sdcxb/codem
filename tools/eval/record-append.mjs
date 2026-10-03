/**
 * **记录追加的"重复键"处置**（第 117 波）—— 纯函数，便于判据钉住。
 *
 * ## 背景（代价已付过两次）
 *
 * 判定器与成对报告都按 **(caseId, runNumber)** 配对。同一个键出现两条（结果还可能不同）
 * ⇒ 该对**直接被阻塞**，那一轮等于白跑。实测：
 *  · `repo-02 / control / run-2`：策略复跑写过 failed，补跑链又写 passed；
 *  · `repo-06 / treatment / run-2`：errored 一条，重跑又写一条 failed。
 *
 * ## 原则：**既不阻塞配对，也不丢数据**
 *
 * 新来的重复记录被**挪到高位 run 号**（默认 900 起），并带上 `parkedFrom` / `parkNote`：
 *  · 同一个 (caseId, runNumber) 只剩最早那条 ⇒ 配对永远干净；
 *  · 多出来的那次运行仍在文件里 ⇒ 事后可查、可复用（不是"删掉"）。
 */

/** 高位 run 号的起点（正常运行号都在 1–9，留足空间） */
export const PARK_BASE = 900;

/**
 * 这条记录是不是"被挪位的"（第 117 波）。
 *
 * 判定看**两个**信号，缺一不可：
 *  · `parkedFrom`/`parkNote`：主动挪位时写的出处（最可靠）；
 *  · `runNumber >= PARK_BASE`：兜底（万一某些记录只改了号、没写出处）。
 *
 * **为什么必须抽成一个共享函数**：报告（`ab-report` / `repo-paired-report`）与判定器都要排除挪位记录
 * （它们来自效度不同期：泄漏期 / docs 清理之前）。第一版我把这条过滤写在了
 * `repo-paired-report.mjs` 的**读取路径**里 —— 那样 `summarize()` 级别的自测覆盖不到，
 * 换个调用方就绕过去了。现在只有一份实现，判据在 `src/test/eval-record-append.test.ts`。
 */
export function isParkedRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.parkedFrom !== undefined || record.parkNote !== undefined) return true;
  return typeof record.runNumber === "number" && record.runNumber >= PARK_BASE;
}

/**
 * 决定"这条记录该以什么 run 号写进去"。
 *
 * @param existingRows 现有记录（用来查重与找空位）
 * @param record       待写入的记录（不会被修改；返回的是副本）
 * @returns `{ record, parked, warning }`
 */
export function planRecordAppend(existingRows, record, parkBase = PARK_BASE) {
  const duplicates = existingRows.filter((r) => r.caseId === record.caseId && r.runNumber === record.runNumber);
  if (duplicates.length === 0) return { record, parked: false, warning: null };

  const used = existingRows.filter((r) => typeof r.runNumber === "number" && r.runNumber >= parkBase).map((r) => r.runNumber);
  const wanted = record.runNumber;
  const nextRun = Math.max(parkBase - 1, ...used) + 1;
  const parkedRecord = {
    ...record,
    runNumber: nextRun,
    parkedFrom: wanted,
    parkNote:
      `本应是 run-${wanted}，但该键已有 ${duplicates.length} 条` +
      `（结果 ${duplicates.map((r) => r.outcome).join("/")}）—— 同一个 (caseId, runNumber) 只能有一条，` +
      `否则配对会被阻塞；按"不丢数据"原则挪到高位 run 号`,
  };
  return {
    record: parkedRecord,
    parked: true,
    warning:
      `${record.caseId} 的 run-${wanted} 已存在（${duplicates.map((r) => r.outcome).join("/")}）` +
      ` ⇒ 本次结果挪到 run-${nextRun}（数据不丢，配对不受影响）`,
  };
}
