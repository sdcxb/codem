/**
 * 重复调用守卫契约（第 62 波立，第 64 波改判据）。
 *
 * 事故复现（用户贴出的控制台日志）：把长对话交接给新会话后，新会话**连续几十次**
 * 执行几乎一样的目录枚举，只换装饰性开关，直到父会话等待超时（十几分钟无产出）。
 *
 * ## 第 64 波为什么重做（用户质疑：用时间或次数做可靠性有问题）
 *
 * 上一版是「同一目标枚举到第 10 次就停」。那是**拿次数当可靠性**：
 *   · 合法的反复查看（列目录 → 读文件 → 再列目录）会被误杀；
 *   · 而"换十几种写法拿到同一份内容"这种真正的打转，靠计数要数到 10 次才拦。
 * 现在唯一的重判据是**信息增益**：`noteResult` 比较**结果内容**，
 * 「连续 N 次拿到已经见过的内容、且期间没有任何写操作」= **可证明的零进展**。
 * 次数只是去抖；**结果变了就是有进展，永远不拦**（见 GUARD-10）。
 */

import { describe, it, expect } from "vitest";
import { RepeatGuard, bashIntent, exactSignature, normalizePath, digestOf, DEFAULT_GUARD_LIMITS } from "../core/llm/loop-guard";

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

/** 事故现场两个目录的真实列表输出 */
const LISTING_ROOT = Array.from({ length: 42 }, (_, i) => `-a----  2026-09-12  12345  文件${i}.docx`).join("\n");
const LISTING_SUB = Array.from({ length: 26 }, (_, i) => `-a----  2026-09-13   2222  课题2-${i}.docx`).join("\n");

describe("重复调用守卫（第 64 波：判据是信息增益，不是次数）", () => {
  const CTX = { cwd: ROOT };

  it("GUARD-1: 事故现场的 17 条真实命令，全部识别为「只读目录枚举」", () => {
    const kinds = INCIDENT_COMMANDS.map((c) => bashIntent(c, CTX.cwd).kind);
    expect(kinds.every((k) => k === "enumerate"), `未能识别为枚举：${kinds.join(",")}`).toBe(true);
  });

  it("GUARD-2: 这 17 条命令塌缩成两个目标指纹（项目根目录 / 课题2 子目录）", () => {
    const sigs = new Set(INCIDENT_COMMANDS.map((c) => bashIntent(c, CTX.cwd).signature!));
    expect([...sigs].sort()).toEqual([ROOT.toLowerCase(), SUB.toLowerCase()].sort());
  });

  it("GUARD-3: 复现事故 —— 换十几种写法但拿到同一份内容，会在有限次内被停（不再依赖数到 10 次）", () => {
    const guard = new RepeatGuard();
    const actions: string[] = [];
    for (const [i, cmd] of INCIDENT_COMMANDS.entries()) {
      const decision = guard.inspect("bash", { command: cmd }, CTX);
      actions.push(decision.action);
      if (decision.action === "stop") break;
      // 子会话真实拿到的内容：前两次是新内容（两个目录各一份），之后全是"已经见过的"
      const output = i < 2 ? (i === 0 ? LISTING_ROOT : LISTING_SUB) : i % 2 === 0 ? LISTING_ROOT : LISTING_SUB;
      guard.noteResult("bash", { command: cmd }, output);
    }
    expect(actions.at(-1)).toBe("stop");
    expect(actions.length, `应在有限次内停（事故里是 30+ 次），实际 ${actions.length}`).toBeLessThanOrEqual(12);
    expect(guard.stats.noGainRepeats).toBeGreaterThanOrEqual(DEFAULT_GUARD_LIMITS.noGainStop);
  });

  it("GUARD-4: 提醒档是「边说边做」；抑制/停档不给执行（否则等于没拦）", () => {
    const guard = new RepeatGuard();
    const runs: string[] = [];
    for (let i = 0; i < DEFAULT_GUARD_LIMITS.noGainStop * 2 + 2; i++) {
      const d = guard.inspect("grep", { pattern: "TODO", path: ROOT }, CTX);
      runs.push(d.action);
      if (d.action === "stop") break;
      guard.noteResult("grep", { pattern: "TODO", path: ROOT }, "同样的搜索结果");
    }
    expect(runs[0]).toBe("allow");
    expect(runs).toContain("warn");
    expect(runs).toContain("suppress");
    expect(runs.at(-1)).toBe("stop");
  });

  it("GUARD-5: 写过文件就重置零增益证据（世界变了，老内容也算新信息）", () => {
    const guard = new RepeatGuard();
    const args = { command: `Get-ChildItem "${ROOT}" -File` };
    guard.inspect("bash", args, CTX);
    guard.noteResult("bash", args, LISTING_ROOT);
    for (let i = 0; i < 3; i++) {
      guard.inspect("bash", args, CTX);
      guard.noteResult("bash", args, LISTING_ROOT);
    }
    expect(guard.noGainStreakCount).toBeGreaterThan(0);
    guard.inspect("write", { path: `${ROOT}\\new.md`, content: "x" }, CTX);
    guard.inspect("bash", args, CTX);
    guard.noteResult("bash", args, LISTING_ROOT); // 世界变过了：这一份"老内容"被宽容
    expect(guard.noGainStreakCount).toBe(0);
  });

  it("GUARD-6: 写入类命令（含重定向、git、npm、解释器）被认成 mutate，不当成枚举", () => {
    for (const c of [
      `Set-Content -Path "${ROOT}\\a.txt" -Value x`,
      `Get-ChildItem "${ROOT}" > "${ROOT}\\list.txt"`,
      `git status`,
      `npm run build`,
      `Remove-Item "${ROOT}\\old" -Recurse`,
      `echo hi > out.txt`,
      `node --version`,
    ]) {
      expect(bashIntent(c, CTX.cwd).kind, c).toBe("mutate");
    }
    for (const c of [`Get-Content "${ROOT}\\a.md"`, `Select-String -Path "${ROOT}\\a.md" -Pattern x`]) {
      expect(bashIntent(c, CTX.cwd).kind, c).toBe("other");
    }
  });

  it("GUARD-7: 精确指纹忽略参数顺序与空白，但不抹掉大小写（避免误拦合法读取）", () => {
    expect(exactSignature("grep", { pattern: "a", path: "D:\\p" })).toBe(exactSignature("grep", { path: "D:\\p", pattern: "a" }));
    expect(exactSignature("read", { path: "D:\\A.md" })).not.toBe(exactSignature("read", { path: "D:\\a.md" }));
    expect(normalizePath('"D:/A/B/"')).toBe("d:\\a\\b");
    // 结果摘要只归一化空白，不抹掉数字/时间戳（否则"文件真的变了"会被误判成没变）
    expect(digestOf("a  b\n c")).toBe("a b c");
    expect(digestOf("size 100")).not.toBe(digestOf("size 200"));
  });

  it("GUARD-8: read/write/wait 交给各自缓存处理（它们的回复比守卫更有用）", () => {
    const guard = new RepeatGuard();
    for (const [tool, args] of [
      ["read", { path: `${ROOT}\\a.md` }],
      ["write", { path: `${ROOT}\\a.md`, content: "x" }],
      ["wait_for_delegation", { task_id: "del-1" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const actions = Array.from({ length: 10 }, () => guard.inspect(tool, args, CTX).action);
      expect(new Set(actions), `${tool} 不应被守卫拦（交给缓存）`).toEqual(new Set(["allow"]));
    }
  });

  it("GUARD-9: 空命令/无参数不崩、不误判", () => {
    expect(bashIntent("").kind).toBe("other");
    expect(bashIntent("   ").kind).toBe("other");
    const guard = new RepeatGuard();
    expect(guard.inspect("bash", {}, CTX).action).toBe("allow");
    expect(guard.inspect("bash", undefined, CTX).action).toBe("allow");
    expect(guard.noteResult("bash", {}, "").gained).toBe(true);
  });

  // ===== 第 64 波的关键用例：次数不再决定一切 =====

  it("GUARD-10: **结果一直不同就永远不拦** —— 哪怕同一个命令跑了 30 次（这才是「长任务」）", () => {
    const guard = new RepeatGuard();
    const args = { command: `npm run build` };
    const actions: string[] = [];
    for (let i = 0; i < 30; i++) {
      const d = guard.inspect("bash", args, CTX);
      actions.push(d.action);
      if (d.action === "stop") break;
      guard.noteResult("bash", args, `第 ${i} 次构建输出，行数 ${i * 7}`); // 每次都有新内容
    }
    expect(new Set(actions), `有新信息就不该被拦：${actions.join(",")}`).toEqual(new Set(["allow"]));
    expect(guard.stats.distinctResults).toBe(30);
    expect(guard.stats.noGainRepeats).toBe(0);
  });

  it("GUARD-11: 「列目录 → 读文件 → 再列目录」这种正常节奏不会被判成打转（旧版按次数会误杀）", () => {
    const guard = new RepeatGuard();
    const actions: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = guard.inspect("bash", { command: `Get-ChildItem "${ROOT}" -File` }, CTX);
      actions.push(d.action);
      if (d.action === "stop") break;
      // 目录内容每次都在变（新文件不断出现）→ 新信息
      guard.noteResult("bash", { command: `Get-ChildItem "${ROOT}" -File` }, `${LISTING_ROOT}\n新增文件 ${i}.md`);
      guard.inspect("read", { path: `${ROOT}\\file${i}.md` }, CTX);
      guard.noteResult("read", { path: `${ROOT}\\file${i}.md` }, `文件 ${i} 的内容`);
    }
    expect(
      actions.every((a) => a === "allow" || a === "warn"),
      `有新信息就不该被拦（提醒可以，拦截不行）：${actions.join(",")}`,
    ).toBe(true);
  });

  it("GUARD-12: 换个目标就各自计数（新手段必须放行，不被前面的判定连坐）", () => {
    const guard = new RepeatGuard();
    // 把某个签名逼到"抑制档"（注意别推到"停档"，否则整轮本来就已经结束了）
    for (let i = 0; i < DEFAULT_GUARD_LIMITS.noGainSuppress + 1; i++) {
      guard.inspect("grep", { pattern: "TODO", path: ROOT }, CTX);
      guard.noteResult("grep", { pattern: "TODO", path: ROOT }, "同样的结果");
    }
    expect(guard.noGainStreakCount).toBeGreaterThanOrEqual(DEFAULT_GUARD_LIMITS.noGainSuppress);
    expect(guard.noGainStreakCount).toBeLessThan(DEFAULT_GUARD_LIMITS.noGainStop);
    // 同一个签名 → 跳过
    expect(guard.inspect("grep", { pattern: "TODO", path: ROOT }, CTX).action).toBe("suppress");
    // 换一个新目标 → 允许（否则模型永远没法改策略）
    const fresh = guard.inspect("grep", { pattern: "FIXME", path: `${ROOT}\\src` }, CTX);
    expect(["allow", "warn"], "新手段必须能放行").toContain(fresh.action);
  });

  it("GUARD-13: 只读枚举的提醒仍然存在（文案价值），但它不是拦截依据", () => {
    const guard = new RepeatGuard();
    const warned: string[] = [];
    for (let i = 0; i < DEFAULT_GUARD_LIMITS.enumAdvisoryAt + 1; i++) {
      const d = guard.inspect("bash", { command: `Get-ChildItem "${ROOT}" -File` }, CTX);
      if (d.action === "warn") warned.push(d.message ?? "");
      guard.noteResult("bash", { command: `Get-ChildItem "${ROOT}" -File` }, `${LISTING_ROOT}\n第 ${i} 次的新内容`);
    }
    expect(warned.length).toBeGreaterThanOrEqual(1);
    expect(warned.join("\n")).toMatch(/第 \d+ 次查看同一个目标/);
  });

  it("GUARD-14: 守卫的拦截不会污染「连续错误」计数、也不把抑制算成进展（第 63 波审计结论的回归锁）", () => {
    const fs = require("fs");
    const path = require("path");
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    const anchor = loop.indexOf("this.repeatGuard.inspect(");
    expect(anchor).toBeGreaterThan(-1);
    const block = loop.slice(anchor, anchor + 1600);
    expect(block).toMatch(/status:\s*"completed" as const/);
    expect(block).not.toMatch(/status:\s*"error" as const/);
    expect(loop).toContain("guardSuppressedThisIteration");
    expect(loop).toMatch(/toolCallsInIteration - this\.guardSuppressedThisIteration/);
  });

  it("GUARD-15: 守卫按「轮次」重置 + 结果必须回喂给守卫（否则信息增益判据无从谈起）", () => {
    const fs = require("fs");
    const path = require("path");
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    const runStart = loop.indexOf("async *run(");
    const head = loop.slice(runStart, runStart + 1400);
    expect(head).toContain("this.repeatGuard.reset()");
    expect(head).toContain("this.guardStopMessage = null");
    expect(loop, "执行完必须把结果交给守卫").toMatch(/this\.repeatGuard\.noteResult\(/);
  });

  it("GUARD-16: 阈值是可配置的，且旧的「数到第 10 次就停」已删除", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/loop-guard.ts"), "utf-8");
    expect(src).toMatch(/noGainWarn/);
    expect(src).toMatch(/noGainSuppress/);
    expect(src).toMatch(/noGainStop/);
    expect(src).toMatch(/次数只是去抖|可证明的零进展/);
    expect(src).not.toMatch(/enumStop/);
  });
});
