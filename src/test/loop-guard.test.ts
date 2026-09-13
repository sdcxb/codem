/**
 * 重复工具调用守卫契约（第 62 波）。
 *
 * 事故复现（用户贴出的控制台日志，2026-09-13）：把长对话交接给新会话后，新会话**连续几十次**
 * 执行几乎一样的目录枚举，只换装饰性开关，直到父会话等待超时（十几分钟无产出）。
 *
 * 本文件的第一组断言用的就是**当时那些真实命令**，逐条要求它们塌缩成同一个意图指纹 ——
 * 这是"守卫真的能拦住这次事故"的唯一可信证明（而不是我构造几条漂亮样例）。
 */

import { describe, it, expect } from "vitest";
import { RepeatGuard, bashIntent, exactSignature, normalizePath, DEFAULT_GUARD_LIMITS } from "../core/llm/loop-guard";

const ROOT = "D:\\方案类项目\\制造运营管控agent标准";
const SUB = "D:\\方案类项目\\制造运营管控agent标准\\集中办公材料\\第二轮\\课题2";

/** 事故现场的真实命令（原样抄自控制台日志） */
const INCIDENT_COMMANDS = [
  `cd "${ROOT}"; Get-ChildItem -Filter "*.docx" | Where-Object {$_.Name -like "*3000*" -or $_.Name -like "*课题二*"} | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize`,
  `cd "${ROOT}"; Get-ChildItem | Select-Object Mode, Length, LastWriteTime, Name | Format-Table -AutoSize`,
  `Get-ChildItem -Force "${ROOT}" | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize`,
  `if (Test-Path "${SUB}") { Get-ChildItem -Force "${SUB}" | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize } else { "路径不存在" }`,
  `Get-ChildItem -Path "${ROOT}" -File | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200`,
  `Get-ChildItem -Path "${SUB}" -File | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200`,
  `Get-ChildItem "${ROOT}" -File | Where-Object { $_.Name -like "*课题二*" -or $_.Name -like "*研究任务*" } | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200`,
  `Get-ChildItem "${ROOT}" -File | Select-Object Name,@{n='KB';e={[math]::Round($_.Length/1KB,1)}},LastWriteTime | Sort-Object LastWriteTime -Descending | Format-Table -AutoSize`,
  `Get-ChildItem "${SUB}" -File | Select-Object Name,@{n='KB';e={[math]::Round($_.Length/1KB,1)}},LastWriteTime | Sort-Object LastWriteTime -Descending | Format-Table -AutoSize`,
  `Get-ChildItem -Force | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize`,
  `Get-ChildItem -Recurse -Force | Where-Object { $_.Name -match '技术路线图|联动运行机制|研究关系图|3000字版' } | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize -Wrap`,
  `Get-ChildItem -Path '${ROOT}' -Filter '*.docx' | Select-Object Name, Length, LastWriteTime | Sort-Object LastWriteTime -Descending | Format-Table -AutoSize | Out-String -Width 200`,
  `Get-ChildItem "${ROOT}" -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize | Out-String -Width 200`,
  `Get-ChildItem -LiteralPath "${ROOT}" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 40 Name, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200`,
  `if (Test-Path -LiteralPath "${SUB}") { Get-ChildItem -LiteralPath "${SUB}" -Recurse | Sort-Object LastWriteTime -Descending | Select-Object FullName, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}, LastWriteTime | Format-Table -AutoSize | Out-String -Width 250 } else { "路径不存在" }`,
  `Get-ChildItem -Path "${ROOT}" -Filter "*3000字版*" -Recurse | Select-Object FullName, Length, LastWriteTime | Format-List`,
  `Get-ChildItem -Path "${ROOT}" -File -Filter "研究任务一-技术路线图*" | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize`,
];

describe("重复工具调用守卫（第 62 波）", () => {
  /** 事故现场：会话 cwd 就是项目根目录（日志里 `cd "D:\方案类项目\制造运营管控agent标准"`） */
  const CTX = { cwd: ROOT };

  it("GUARD-1: 事故现场的 17 条真实命令，全部识别为「只读目录枚举」", () => {
    const kinds = INCIDENT_COMMANDS.map((c) => bashIntent(c, CTX.cwd).kind);
    expect(kinds.every((k) => k === "enumerate"), `未能识别为枚举：${kinds.join(",")}`).toBe(true);
  });

  it("GUARD-2: 这 17 条命令塌缩成**两个**意图指纹（项目根目录 / 课题2 子目录）", () => {
    // 裸命令（`Get-ChildItem -Force` 没带路径）靠会话 cwd 归到项目根目录 ——
    // 没有 cwd 时它们只能记成 <cwd>，会少合并一半（这正是本波加上 cwd 参与指纹的原因）
    const sigs = new Set(INCIDENT_COMMANDS.map((c) => bashIntent(c, CTX.cwd).signature!));
    expect([...sigs].sort()).toEqual([ROOT.toLowerCase(), SUB.toLowerCase()].sort());
    // 不给 cwd 时退化成 <cwd>，仍然不会误判成别的目标
    const withoutCwd = new Set(INCIDENT_COMMANDS.map((c) => bashIntent(c).signature!));
    expect(withoutCwd.has("<cwd>")).toBe(true);
    expect(withoutCwd.size).toBe(3);
  });

  it("GUARD-3: 守卫在第 4 次提醒、第 7 次抑制、第 10 次直接停 —— 不会拖到十几分钟", () => {
    // 事故的形态是「同一目标反复枚举」（同一目录换了十几种写法），按这个序列复现
    const guard = new RepeatGuard();
    const sameTarget = [...INCIDENT_COMMANDS.filter((c) => bashIntent(c, CTX.cwd).signature === ROOT.toLowerCase())];
    while (sameTarget.length < 12) sameTarget.push(...sameTarget.slice(0, 12 - sameTarget.length));
    const decisions = sameTarget.slice(0, 12).map((c) => guard.inspect("bash", { command: c }, CTX));

    expect(decisions.slice(0, 3).map((d) => d.action)).toEqual(["allow", "allow", "allow"]); // 前 3 次放行
    expect(decisions[3].action).toBe("warn"); // 第 4 次提醒（仍然执行）
    expect(decisions[6].action).toBe("suppress"); // 第 7 次起抑制（不执行）
    expect(decisions[9].action).toBe("stop"); // 第 10 次直接停
    // 一旦进入停档，后续仍然是停（调用方应当立刻 break，而不是继续问）
    expect(decisions.slice(9).every((d) => d.action === "stop")).toBe(true);
    expect(guard.stats.stopped).toBeGreaterThanOrEqual(1);
    // 停的那条引导语必须给出「别再枚举、去读文件或直接报告缺什么」的出路
    expect(decisions[9].message).toMatch(/停止枚举/);
    expect(decisions[9].message).toMatch(/报告/);
  });

  it("GUARD-4: 只有提醒档是「边说边做」，抑制/停档不给执行（否则等于没拦）", () => {
    const guard = new RepeatGuard();
    const actions: string[] = [];
    for (let i = 0; i < DEFAULT_GUARD_LIMITS.enumStop; i++) {
      actions.push(guard.inspect("bash", { command: `Get-ChildItem "${ROOT}" -File` }, CTX).action);
    }
    expect(actions.filter((a) => a === "allow").length).toBe(5); // n=1,2,3,5,6
    expect(actions.filter((a) => a === "warn").length).toBe(1); // n=4，只提醒一次
    expect(actions.filter((a) => a === "suppress").length).toBe(3); // n=7,8,9
    expect(actions.at(-1)).toBe("stop"); // n=10
  });

  it("GUARD-5: 中途写过文件就重置枚举计数（世界变了，重新枚举是合理的）", () => {
    const guard = new RepeatGuard();
    for (let i = 0; i < 6; i++) guard.inspect("bash", { command: `Get-ChildItem "${ROOT}" -File` }, CTX);
    guard.inspect("write", { path: `${ROOT}\\a.md`, content: "x" }, CTX);
    const afterWrite = guard.inspect("bash", { command: `Get-ChildItem "${ROOT}" -File` }, CTX);
    expect(afterWrite.action).toBe("allow");
    expect(afterWrite.count).toBe(1);
  });

  it("GUARD-6: 写入类命令（含重定向、git、npm…）被认成 mutate，不当成枚举", () => {
    const mutates = [
      `Set-Content -Path "${ROOT}\\a.txt" -Value x`,
      `Get-ChildItem "${ROOT}" > "${ROOT}\\list.txt"`,
      `git status`,
      `npm run build`,
      `Remove-Item "${ROOT}\\old" -Recurse`,
      `echo hi > out.txt`,
      // 解释器/构建工具一律按「可能改盘」处理（保守方向：宁可漏判循环，也不误杀构建/测试）
      `node --version`,
      `python -c "print(1)"`,
    ];
    for (const c of mutates) expect(bashIntent(c, CTX.cwd).kind, c).toBe("mutate");
    // 只读但不属于目录枚举（看内容/搜索）→ other，既不清零也不合并意图
    for (const c of [`Get-Content "${ROOT}\\a.md"`, `Select-String -Path "${ROOT}\\a.md" -Pattern x`]) {
      expect(bashIntent(c, CTX.cwd).kind, c).toBe("other");
    }
  });

  it("GUARD-7: 精确指纹忽略参数顺序与大小写；不同参数必须是不同指纹", () => {
    expect(exactSignature("read", { path: "D:\\a.md", limit: 100 })).toBe(
      exactSignature("read", { limit: 100, path: "d:\\A.md" }),
    );
    expect(exactSignature("read", { path: "D:\\a.md" })).not.toBe(exactSignature("read", { path: "D:\\b.md" }));
    expect(normalizePath('"D:/A/B/"')).toBe("d:\\a\\b");
  });

  it("GUARD-8: 完全相同的调用第 5 次被抑制（覆盖 bash 之外的通用工具）", () => {
    const guard = new RepeatGuard();
    const args = { path: `${ROOT}\\x.md` };
    const actions = Array.from({ length: 5 }, () => guard.inspect("read", args, CTX).action);
    expect(actions).toEqual(["allow", "allow", "warn", "allow", "suppress"]);
  });

  it("GUARD-9: 自带缓存/去重的工具不再叠一层（wait_for_delegation 等）", () => {
    const guard = new RepeatGuard();
    const args = { task_id: "del-1" };
    const actions = Array.from({ length: 8 }, () => guard.inspect("wait_for_delegation", args, CTX).action);
    expect(new Set(actions)).toEqual(new Set(["allow"]));
  });

  it("GUARD-10: 每次路径不同就不该触发（别把正常的逐个查看误杀）", () => {
    const guard = new RepeatGuard();
    const actions = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      guard.inspect("bash", { command: `Get-ChildItem "D:\\proj\\dir${i}" -File` }, CTX).action,
    );
    expect(new Set(actions)).toEqual(new Set(["allow"]));
  });

  it("GUARD-11: 换个目标就各自计数（不同目录互不牵连）", () => {
    const guard = new RepeatGuard();
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) {
      seq.push(guard.inspect("bash", { command: `Get-ChildItem "${ROOT}" -File` }, CTX).action);
      seq.push(guard.inspect("bash", { command: `Get-ChildItem "${SUB}" -File` }, CTX).action);
    }
    // 各自第 4 次才是 warn，绝不会因为"总次数"到了就提前拦
    expect(seq).toEqual(["allow", "allow", "allow", "allow", "allow", "allow", "warn", "warn"]);
  });

  it("GUARD-12: 空命令/无参数不崩、不误判", () => {
    expect(bashIntent("").kind).toBe("other");
    expect(bashIntent("   ").kind).toBe("other");
    const guard = new RepeatGuard();
    expect(guard.inspect("bash", {}, CTX).action).toBe("allow");
    expect(guard.inspect("bash", undefined, CTX).action).toBe("allow");
  });
});
