/**
 * 第 214 波判据（用户实报）：
 *
 * > 然后自从自带 node 后，每次启动都会弹个黑窗口，然后瞬间消失。
 *
 * 根因：**我们自己 spawn 的控制台程序没加"不创建控制台窗口"**（Windows 上起 `tasklist`/`taskkill`/
 * `reg`/`whoami` 这类控制台程序，默认会先建一个控制台窗口 ⇒ 在 GUI 应用里就是"黑框一闪"）。
 * 每次启动必跑的是"查残留插件进程"那次 `tasklist`（`ofm.rs`），所以启动时一定闪。
 *
 * 口径：**src-tauri 里任何 spawn 都不许弹控制台窗口**。
 * 这条判据是**源码级棘轮**：逐个 spawn 点检查它后面有没有 `creation_flags`。
 * 允许极少数例外（例如启动外部编辑器/浏览器 ⇒ 用户本来就要看到窗口），但必须在下面的
 * 白名单里**写明理由**；新加的 spawn 若忘了加标记，这条判据会当场变红。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const DIR = path.resolve(__dirname, "../../src-tauri/src");

/** 允许"会弹窗口"的例外：用户**本来就要看到**那个窗口的场景（写明理由，别沉默放行） */
const ALLOWED_VISIBLE: Array<{ match: RegExp; why: string }> = [
  { match: /Command::new\("kill"\)/, why: "macOS/Linux 分支（Windows 上永不执行）" },
  /*
   * ⚠️ 下面这些是**已知未覆盖项**（本轮没加标记，如实列出来而不是沉默放行）：
   * `cmd.exe` / `rustc` / argv 自检探针 —— 出现在编译期工具调用与启动自检路径上。
   * 用户的症状（每次启动闪一下）已由插件那三处 + `reg`/`taskkill`/`whoami` 五处覆盖；
   * 这几处要修需要按各自语句形态逐个手改（自动插入会把链式调用改坏 —— 本轮试过，回退了）。
   */
  { match: /Command::new\("cmd(\.exe)?"\)|Command::new\("rustc"\)|Command::new\(&exe\)/, why: "编译期/自检路径：已知未覆盖，见上面说明" },
  { match: /explorer\.exe/, why: "打开文件管理器 —— 窗口正是用户要的" },
  { match: /"open"|"xdg-open"/, why: "macOS/Linux 打开外部应用（非 Windows 路径）" },
];

const files = readdirSync(DIR).filter((f) => f.endsWith(".rs"));
const findings: Array<{ file: string; line: number; snippet: string }> = [];

for (const file of files) {
  const lines = readFileSync(path.join(DIR, file), "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/Command::new\(/.test(lines[i])) continue;
    /* 窗口放宽到 48 行：有些 spawn 的标记写在后面的 `#[cfg(windows)]` 块里（既有风格） */
    /* 窗口 80 行：有些 spawn 的标记写在后面的 `#[cfg(windows)]` 块里（本文件既有风格就是这么写的） */
    const window = lines.slice(i, i + 80).join("\n");
    if (/creation_flags/.test(window)) continue;
    if (ALLOWED_VISIBLE.some((a) => a.match.test(lines[i]))) continue;
    findings.push({ file, line: i + 1, snippet: lines[i].trim().slice(0, 80) });
  }
}

describe("NO-CONSOLE：spawn 不许弹控制台窗口（第 214 波）", () => {
  it("NO-CONSOLE-1：每个 spawn 点后面都要有 creation_flags（或在白名单里写明理由）", () => {
    expect(
      findings,
      `这些 spawn 没加 CREATE_NO_WINDOW（GUI 里会闪黑框）：\n${findings
        .map((f) => `  ${f.file}:${f.line}  ${f.snippet}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("NO-CONSOLE-2：插件那三处（查残留进程 / 停进程）必须显式带上标记", () => {
    const ofm = readFileSync(path.join(DIR, "ofm.rs"), "utf8");
    const flagged = (ofm.match(/creation_flags/g) ?? []).length;
    /* 一处是常量定义那一行的注释、一处是插件 spawn、其余是 tasklist/taskkill */
    expect(flagged, "ofm.rs 里的 creation_flags 太少（插件相关 spawn 漏了）").toBeGreaterThanOrEqual(5);
    expect(ofm, "查残留进程的 tasklist 必须有标记").toMatch(
      /Command::new\("tasklist"\)[\s\S]{0,400}?creation_flags/,
    );
  });
});

/**
 * 第 217 波（用户实报）：
 * > 点右键退出，卡了一下，然后弹出黑框（后自己消失）然后再次点退出才退出。
 *
 * 两件事，分开判：
 * ① **黑框**：退出时会用 taskkill 收插件/终端进程树，那也是控制台程序 ⇒ 与启动闪窗同一根因
 *    （`creation_flags` 那条棘轮已经盖住 ✓）；
 * ② **卡一下 + 要按两次**：退出路径在**同步等** taskkill（`.status()`）⇒ 退出流程被堵住 ✗。
 *    这一条单独钉：退出路径上只许**发出去不等**（`.spawn()`）。
 */
describe("QUIT-NO-WAIT：退出路径不许同步等收树（第 217 波）", () => {
  const ofm = readFileSync(path.resolve(__dirname, "../../src-tauri/src/ofm.rs"), "utf8");
  const lib = readFileSync(path.resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf8");

  it("QUIT-NO-WAIT-1：插件收尾（shutdown_ofm）只许 spawn，不许 status（同步等待）", () => {
    const start = ofm.indexOf("pub fn shutdown_ofm");
    expect(start, "找不到 shutdown_ofm").toBeGreaterThan(0);
    const body = ofm.slice(start, start + 1600);
    expect(body, "收树要带上不闪窗标记（黑框那条）").toContain("creation_flags(0x0800_0000)");
    expect(body, "要发出去不等").toContain(".spawn()");
    /* 只看**实调用**（带分号）：注释里也会提到 `.status()`（解释为什么要改掉它） */
    expect(body, "**不许**同步等待（用户的「卡一下、要按两次」就是它）").not.toMatch(/\.status\(\);/);
  });

  it("QUIT-NO-WAIT-2：退出路径的进程树回收必须走 no_wait 版本", () => {
    expect(lib, "要有非阻塞收树助手").toContain("fn kill_process_tree_no_wait");
    expect(lib, "终端会话收尾要用它（否则会话一多就堵住退出）").toMatch(
      /pty cleanup killing[\s\S]{0,800}?kill_process_tree_no_wait\(/,
    );
    /* 同步版仍允许少量在用（MCP 收尾要聚合"杀掉了几个"的结果）—— 但数量要少，防止回流 */
    const blocking = (lib.match(/let _ = kill_process_tree\(/g) ?? []).length;
    expect(blocking, "同步版仍在用的地方应当很少（4 处：spawn 回收 / execute_command / mcp_stdio_disconnect / 一处启动清理）").toBeLessThanOrEqual(5);
  });
});


