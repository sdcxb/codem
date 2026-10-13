/**
 * 第 227 波（用户实报）：
 *
 * > 更新后重启提示【免费模型插件没有启动起来：插件进程起来了，但 18937 上的服务在 30 秒内没有就绪
 * > （可看运行日志）。到「插件管理 → 插件市场」那张卡片上点「刷新状态」看真实原因；
 * > 装一个 Node.js 22+ 之后重试即可。】
 *
 * ## 那句话的三个毛病（用户直接读出来的）
 *
 * 1. **指错地方**：卡片在「插件管理 → Our Free Model」，「插件市场」是另一个页签（dsh 插件目录）
 *    ⇒ 用户会去一个永远找不到这张卡片的地方找；
 * 2. **给错动作**：Node 明明装着（"没 Node"有它自己那条分支与文案），却让人去装 Node；
 * 3. **没给真原因**：插件自己的最后一行输出（`plugin.log`，卡片上就有）才是答案 ——
 *    真机上它是「启动失败：数据目录已被服务占用，请检查 service.lock 中的进程」。
 *
 * ## 这一族判据守两件事
 *
 * - **纯函数**：把（日志尾部 + 锁里的 pid + 端口）翻译成"人读的原因 + 用户做得到的下一步"；
 * - **接线**：真机上那条死局（上一次运行留下的插件进程占着数据目录 ⇒ 新实例一起就退）
 *   必须有**可执行的出口** —— 自动重试一次 + 卡片上那颗「结束残留进程并重试」按钮；
 *   而且结束进程这件事**只能在能证明那个 pid 是本插件时**才做（否则会误杀别人的进程）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describePluginStartFailure, lastMeaningfulLogLine } from "../core/free-model-plugin/model-index";

const root = path.resolve(__dirname, "../..");
const service = readFileSync(path.join(root, "src/core/free-model-plugin/service.ts"), "utf8");
const ofm = readFileSync(path.join(root, "src-tauri/src/ofm.rs"), "utf8");
const card = readFileSync(path.join(root, "src/components/FreeModelPluginCard.tsx"), "utf8");
const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");

/** 真机上插件自己打的那一行（逐字抄自 `plugin.log`） */
const REAL_LOCK_LINE =
  "[stderr] 启动失败：数据目录已被服务占用，请检查 service.lock 中的进程；异常退出后确认旧进程停止再移除锁文件。";

describe("OFM-START-FAIL：插件起不来时到底该说什么（第 227 波）", () => {
  it("OFM-START-FAIL-1：日志里是「数据目录被占用」⇒ 点出**残留进程号**并给出可执行的下一步", () => {
    const out = describePluginStartFailure({ logTail: REAL_LOCK_LINE, lockPid: 5820, port: 18937 });
    expect(out.message, "要说清真实原因（上一次运行留下的进程占着数据目录）").toContain("上一次运行留下的插件进程");
    expect(out.message, "并点出进程号（用户/客服都能核对）").toContain("5820");
    expect(out.message, "端口要写对").toContain("18937");
    expect(out.message, "要引用插件自己的原话（不是我编的解释）").toContain("数据目录已被服务占用");
    expect(out.message, "不许再提「装 Node」（这条分支跟 Node 无关）").not.toContain("Node");
    expect(out.nextStep, "下一步必须是用户做得到的一个按钮").toContain("结束残留进程并重试");
    expect(out.nextStep, "且不许指去插件市场").not.toContain("插件市场");
  });

  it("OFM-START-FAIL-2：没有 pid 时也要说清，且仍然不许提 Node / 插件市场", () => {
    const out = describePluginStartFailure({ logTail: REAL_LOCK_LINE, lockPid: null, port: 18937 });
    expect(out.message).toContain("数据目录");
    expect(out.message).not.toContain("Node");
    expect(out.nextStep).toContain("结束残留进程并重试");
    expect(out.nextStep).not.toContain("插件市场");
  });

  it("OFM-START-FAIL-3：插件**一行输出都没有** ⇒ 如实说「没有输出」，并给出查看日志的去处", () => {
    const out = describePluginStartFailure({ logTail: "", lockPid: null, port: 18937 });
    expect(out.message, "不许把'没有输出'编成某个具体原因").toContain("一行输出都没有");
    expect(out.nextStep, "要去处正确").toContain("Our Free Model");
    expect(out.nextStep, "并说清看什么（插件运行日志）").toContain("插件运行日志");
  });

  it("OFM-START-FAIL-4：其它报错 ⇒ 引用插件自己的最后一行输出，并指向正确的卡片位置", () => {
    const out = describePluginStartFailure({
      logTail: "[stderr] Error: Cannot find module '/x/cli.mjs'\n\n",
      lockPid: null,
      port: 18937,
    });
    expect(out.message, "要引用原话（不加工）").toContain("Cannot find module");
    expect(out.nextStep).toContain("Our Free Model");
    expect(out.nextStep).toContain("插件运行日志");
  });

  it("OFM-START-FAIL-5（纯函数）：日志尾部取**最后一条有内容**的行，且剥掉 [stderr]/[stdout] 前缀", () => {
    expect(lastMeaningfulLogLine("")).toBe("");
    expect(lastMeaningfulLogLine("[stdout] a\n[stderr] b\n\n")).toBe("b");
    expect(lastMeaningfulLogLine("only one line")).toBe("only one line");
  });
});

describe("OFM-START-FAIL：接线（第 227 波结构棘轮）", () => {
  it("OFM-START-FAIL-6：起不来时先**自动**清一次残留进程再重试一次，两次都失败才报错", () => {
    expect(service, "要调用结束残留进程的命令").toContain('invoke<number | null>("ofm_kill_lock_holder"');
    expect(service, "失败路径要先尝试回收（live 死局的唯一出口）").toMatch(
      /if \(!run\.health\) \{[\s\S]{0,400}?killStuckLockHolder\(run\.state\.pid/,
    );
    expect(service, "回收成功要**再起一次**（否则等于没救）").toMatch(/if \(killedPid !== null\) run = await attempt\(\)/);
    expect(service, "两次都失败时，消息与下一步来自那个纯函数").toContain("describePluginStartFailure({");
    expect(service, "失败消息要带上插件自己的输出").toContain("readLogTail(8)");
    expect(service, "启动成功且回收过 ⇒ 如实说明（别把'救回来了'说成'一次成功'）").toMatch(
      /killedPid !== null \? `已结束上一次留下的残留插件进程/,
    );
  });

  it("OFM-START-FAIL-7：结束进程这件事有三条安全边界（误杀别人的进程是不可接受的）", () => {
    expect(ofm, "要有那个命令").toContain("pub async fn ofm_kill_lock_holder");
    expect(ofm, "只认锁里的 pid").toContain("fn lock_holder_pid");
    expect(ofm, "必须读那个进程的命令行（读不出来不动手）").toContain("fn process_command_line");
    expect(ofm, "只有命令行里出现本插件的数据目录才允许结束它").toContain("fn is_our_plugin_command");
    expect(ofm, "绝不结束调用方自己刚起的那个进程").toContain("if exclude_pid == Some(pid)");
    expect(ofm, "命令行不像本插件（pid 被复用）⇒ 只删锁、不杀进程").toMatch(
      /if !is_our_plugin_command\(&command_line, &data_dir\) \{[\s\S]{0,200}?remove_file\(&lock\)[\s\S]{0,80}?Ok\(None\)/,
    );
    expect(ofm, "收树要带上不闪窗标记（第 214 波的棘轮）").toMatch(
      /Command::new\("taskkill"\)[\s\S]{0,400}?creation_flags\(0x0800_0000\)/,
    );
  });

  it("OFM-START-FAIL-8：卡片上那颗按钮真的接了服务层；暂停也要收掉「上一次留下的实例」", () => {
    expect(card, "卡片要有这颗按钮").toContain("结束残留进程并重试");
    expect(card, "接了服务层的 recoverAndRestart").toContain("freeModelPlugin.recoverAndRestart()");
    expect(card, "只在'没就绪'时出现（健康时不该给用户一个危险按钮）").toMatch(
      /status\.enabled && status\.codePresent && !!status\.nodeExe && !status\.health && \(/,
    );
    expect(service, "要导出 recoverAndRestart").toMatch(/recoverAndRestart,/);
    expect(service, "暂停必须收掉不是本进程起的那个实例（否则界面说暂停、服务还在答）").toMatch(
      /await invoke<void>\("ofm_stop"\);[\s\S]{0,600}?await killStuckLockHolder\(null\)/,
    );
  });

  it("OFM-START-FAIL-9：接手来的实例必须**如实**标出来（不许写「尚未启动」而服务在答）", () => {
    expect(service, "状态里要有 adopted 这个事实").toMatch(/adopted\?: boolean/);
    expect(service, "本进程没起过它、但服务在答 ⇒ 认领它").toMatch(
      /if \(!base\.running && base\.port\) \{[\s\S]{0,400}?base\.adopted = true/,
    );
    expect(card, "卡片文案要标'上一次启动的实例'").toContain("（上一次启动的实例）");
  });

  it("OFM-START-FAIL-10：App 侧那句**指错地方 + 给错动作**的兜底必须不再出现", () => {
    /* 只看**代码行**：注释里正引着那句旧文案解释"为什么要改"（拿全文匹配会把它算进去） */
    const appCode = app
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(appCode, "不许再让用户去装 Node（那条分支另有文案）").not.toContain("装一个 Node.js 22+ 之后重试即可");
    expect(appCode, "不许再指去「插件市场」").not.toContain("插件管理 → 插件市场");
    expect(app, "要用服务层算出来的下一步").toMatch(/started\.nextStep \?\?/);
    expect(app, "兜底去处也要写对").toContain("插件管理 → Our Free Model");
  });
});
