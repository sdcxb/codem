/**
 * 第 46 波：**工具命令的 PowerShell 启动参数** ✓（正确性优先，速度是顺带 ✓）。
 *
 * ## 为什么（实测 + 两条真风险 ✓）
 *
 * Rust 侧统一用 PowerShell 跑命令（`lib.rs` 的 `Command::new("powershell")` ✓），
 * 而它原来**没有 `-NoProfile` / `-NonInteractive`** ✗：
 *
 * | 风险 | 说明 |
 * |---|---|
 * | ★ **污染工具输出** | 用户的 profile 只要 `Write-Host` 一句（欢迎语、代理设置、conda 初始化… ✓），**每个工具结果**都会多出那段文字 ✗ ⇒ 模型读到的是"命令输出 + 噪声"✗ |
 * | ★ **可能挂住** | profile 里若有交互式提示（或命令本身要输入 ✓），没有 `-NonInteractive` 就会**卡到超时** ✗ |
 * | 速度（顺带 ✓）| 实测本机：带 profile **271 ms/次** vs `-NoProfile -NonInteractive` **224 ms/次** ⇒ 差 **48 ms/次** ✓（≈12 s/批 ⇒ **不是**主要收益 ✓，如实写 ✓）|
 *
 * ## 判据
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `SH-1` | 那处 spawn 必须带 `-NoProfile` ✓ | 去掉 ⇒ 红 |
 * | `SH-2` | 也必须带 `-NonInteractive` ✓（防挂住 ✓）| 去掉 ⇒ 红 |
 * | `SH-3`（反向对照）| `-Command` 与命令体装配**不许**被弄丢 ✓（改了参数还得能跑 ✓）| 丢掉 `-Command` ⇒ 红 |
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
/** 只剥 `//` 行注释 ✓（Rust 的块注释在这段里没有 ✓；本仓注释里会逐字引用旧写法 ✗） */
const rustSource = () =>
  readFileSync(join(ROOT, "src-tauri", "src", "lib.rs"), "utf8")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

/**
 * ★ 只取**那条参数链本身**（含 `.arg("-Command")` 的那一行 ✓）。
 *
 * ⚠️ 第一版取的是"`Command::new("powershell")` 到 `.arg("-Command")`"**整段** ✗ ——
 * 那段里包含了整个函数体 ✓ ⇒ 只要那段**任何地方**出现 `-NoProfile` 就通过 ✗
 * （**假绿**风险 ✓，与本仓 §6 第 2 条同源 ✓）。现在钉的是**装配参数的那一行** ✓。
 */
function spawnArgLine(): string {
  const src = rustSource();
  const line = src
    .split("\n")
    .find((l) => l.includes('.arg("-Command")'));
  expect(line, "找不到装配 `-Command` 的那一行 ⇒ 判据自己先失效 ✗").toBeTruthy();
  return String(line);
}

describe("第 46 波：工具命令的 PowerShell 启动参数", () => {
  it("SH-1: 参数链必须带 `-NoProfile`（否则用户 profile 的输出会污染每个工具结果 ✗）", () => {
    const line = spawnArgLine();
    console.log("[SH-1] 参数链：", line.trim().slice(0, 200));
    expect(line, "★ 没有 -NoProfile ⇒ profile 的一句话会出现在每个工具的 stdout 里 ✗").toContain("-NoProfile");
  });

  it("SH-2: 参数链必须带 `-NonInteractive`（防 profile/命令的交互提示把命令挂住 ✗）", () => {
    expect(spawnArgLine(), "没有 -NonInteractive ⇒ 交互式提示会卡到超时 ✗").toContain("-NonInteractive");
  });

  it("SH-3 反向对照: `-Command` 与命令体装配不许被弄丢（改了参数还得能跑 ✓）", () => {
    const src = rustSource();
    expect(src, "`-Command` 必须还在").toContain('.arg("-Command")');
    expect(src, "命令体（UTF-8 前缀 + 用户命令）必须还在").toContain("let full_command = format!");
    expect(src, "要把 full_command 交给 PowerShell").toContain('.arg(&full_command)');
  });
});
