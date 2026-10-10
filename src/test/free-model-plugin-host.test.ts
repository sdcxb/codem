/**
 * 第 201 波判据（宿主侧结构棘轮）：免费模型插件的**关键接线**必须一直存在。
 *
 * ## 为什么用"扫源码"的形态
 *
 * Rust 那一侧（起停进程、路径、退出清理、锁自愈）没法在 vitest 里真跑 —— 它要么依赖 Tauri 运行时，
 * 要么依赖真实进程。这些接线每一条都是**真机上踩出来的**（见 `src-tauri/src/ofm.rs` 的注释），
 * 而它们一旦被后来的重构删掉，症状是"插件装上了但永远起不来/退不掉"，非常难查。
 * 所以这里按本仓既有的棘轮做法（如 `SYSINJ-4` 扫 `agentic-loop.ts`）把"必须存在的那几处"锁住：
 * 删掉任何一处 ⇒ 本文件当场变红并说明后果。
 *
 * 真机证据（装机版 1.16.309）记在 `docs/HANDOFF-NEXT-SESSION.md` 第 201 波一节。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("OFM-HOST：免费模型插件的宿主接线棘轮", () => {
  const ofmRs = read("src-tauri/src/ofm.rs");
  const libRs = read("src-tauri/src/lib.rs");
  const tauriConf = read("src-tauri/tauri.conf.json");

  it("OFM-HOST-1：路径必须去掉逐字前缀（否则 Node 解析入口崩成 EISDIR lstat 'C:'）", () => {
    expect(ofmRs, "strip_verbatim 没了 ⇒ 逐字路径又会交给 Node").toContain("fn strip_verbatim");
    /*
     * 两个路径命令**各自**都要过一遍（这里刻意不用"出现次数 ≥ N"的写法：
     * 第 201 波的 MUT-12 就是这么漏网的 —— 删掉一个调用点后总数仍 ≥3，判据照样绿）。
     */
    const extensionCmd = ofmRs.slice(ofmRs.indexOf("pub async fn ofm_extension_dir"));
    const bundledCmd = ofmRs.slice(ofmRs.indexOf("pub async fn ofm_bundled_dir"));
    expect(extensionCmd.slice(0, 700), "ofm_extension_dir 没过 strip_verbatim").toContain("strip_verbatim(");
    expect(bundledCmd.slice(0, 1200), "ofm_bundled_dir 没过 strip_verbatim").toContain("strip_verbatim(");
    expect(ofmRs, "注释里要留着这条教训（否则后人会以为是多余代码）").toContain("EISDIR");
  });

  it("OFM-HOST-2：起进程前要清掉「持有者已死」的 service.lock（否则崩溃一次就永久起不来）", () => {
    expect(ofmRs).toContain("fn clear_stale_lock");
    const startIdx = ofmRs.indexOf("pub async fn ofm_start");
    const spawnIdx = ofmRs.indexOf("cmd.spawn()");
    const lockIdx = ofmRs.indexOf("clear_stale_lock(&data_dir)");
    expect(lockIdx, "ofm_start 里必须调用 clear_stale_lock").toBeGreaterThan(startIdx);
    expect(lockIdx, "必须在 spawn **之前**清锁（spawn 之后再清就晚了：插件已经因为锁退出）").toBeLessThan(spawnIdx);
    expect(ofmRs, "只在持有者确实不在跑时才删（不许抢活着的实例的锁）").toContain("tasklist");
  });

  it("OFM-HOST-3：退出时要把插件一起收掉（不然会攒孤儿 node 进程）", () => {
    /*
     * 两处退出钩子**各自**都要有（第 201 波的 MUT-13 就是这样漏网的：删掉一处之后，
     * 「ExitRequested 之后 2000 字内出现过 shutdown_ofm」仍能靠下一处的调用匹配上）。
     * 这里按文件切段判定，不靠"窗口内出现过"。
     */
    const exitIdx = libRs.indexOf("tauri::RunEvent::Exit =>");
    expect(exitIdx, "找不到 RunEvent::Exit（Rust 结构变了？）").toBeGreaterThan(0);
    const beforeExit = libRs.slice(libRs.indexOf("tauri::RunEvent::ExitRequested"), exitIdx);
    const exitArm = libRs.slice(exitIdx, exitIdx + 1200);
    expect(beforeExit, "ExitRequested 那处没有收插件").toContain("ofm::shutdown_ofm");
    expect(exitArm, "RunEvent::Exit 兜底那处没有收插件").toContain("ofm::shutdown_ofm");
    expect(ofmRs, "Windows 上要收整棵树（node 会派生 worker）").toContain("taskkill");
  });

  it("OFM-HOST-4：内置代码随安装包走，且渲染侧能连到本机回环端口（CSP 放行）", () => {
    const conf = JSON.parse(tauriConf) as { bundle?: { resources?: string[] }; app?: { security?: { csp?: string } } };
    expect(
      conf.bundle?.resources?.some((r) => r.includes("resources/ofm")),
      "bundle.resources 里没有内置插件 ⇒ 装完之后 ofm_bundled_dir 找不到代码",
    ).toBe(true);
    expect(conf.app?.security?.csp ?? "", "CSP 必须放行 127.0.0.1（否则渲染侧 fetch 插件一律被拦）").toContain(
      "http://127.0.0.1:*",
    );
  });

  it("OFM-HOST-5：子进程输出必须落盘（GUI 里 eprintln 等于丢掉，错误就查不到了）", () => {
    expect(ofmRs, "plugin.log 落盘没了 ⇒ 又回到「只知道失败、不知道为什么」").toContain("plugin.log");
    expect(ofmRs, "要有读取日志尾巴的命令给界面用").toContain("pub async fn ofm_log_tail");
    expect(ofmRs, "不要再把子进程输出只 eprintln 掉").not.toMatch(/eprintln!\("\[ofm\]/);
  });
});
