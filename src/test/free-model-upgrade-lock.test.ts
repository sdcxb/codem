/**
 * 第 212 波判据（用户实报的**升级被文件占用挡住**）：
 *
 * > 设置里升级，安装的时候提示：无法打开要写入的文件：
 * > "C:\Users\…\AppData\Local\Codem\resources\node\node.exe"
 *
 * 根因链条：内置 Node 放在**安装目录**里 → 没有够新的系统 Node 的机器上，插件**直接运行它**
 * → 安装目录里有活进程占着文件 → 升级写不进去。
 *
 * ## 只保留"实测有效"的两层（这一条本身就是教训）
 *
 * 我先写了一个 NSIS preinstall 钩子（想在写入前收掉占用进程）。**真机实测两轮都没生效**：
 * 钩子在、占用进程活得好好的、文件也没被写入（静默安装对占用文件是"跳过"、退出码仍是 0）。
 * 我单独验证过钩子那段 PowerShell 逻辑**是有效的**（直接执行能把占用进程收掉）⇒ 失效点在
 * "NSIS 怎么调它"这一段，而我没有把它修到能用的证据 ⇒ **按"不留假机制"撤掉了**，
 * 只保留下面两层**可判据约束**的改动：
 *
 * ① 插件运行**数据目录里的副本**（安装目录只剩只读资源 ⇒ 以后不会再锁）；
 * ② 应用内升级前先停插件（释放句柄；**停掉 ≠ 禁用**）。
 *
 * ⚠️ 但必须如实记账：①在**本机验证不了**（这台机器有够新的系统 Node ⇒ 走不到内置分支；
 * 剥掉 PATH 起插件的尝试也没成功）⇒ 判据只能钉住"必须先落位再使用、且退回时留警告"这个形态。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const root = path.resolve(__dirname, "../..");
const service = readFileSync(path.join(root, "src/core/free-model-plugin/service.ts"), "utf8");
const panel = readFileSync(path.join(root, "src/components/SettingsPanel.tsx"), "utf8");
const conf = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));

describe("OFM-UPGRADE：升级时安装目录不许被自己的进程占住（第 212 波）", () => {
  it("OFM-UPGRADE-1（结构棘轮）：内置 Node 必须先落位到数据目录再运行", () => {
    expect(service, "要调用落位命令").toContain('invoke<string>("ofm_stage_node"');
    const branch = service.slice(
      service.indexOf("const bundled = await bundledExe();"),
      service.indexOf("const r = await resolveNodeExe("),
    );
    expect(branch, "内置分支里要有落位调用").toContain("ofm_stage_node");
    expect(branch, "落位拿到的路径要被用上").toMatch(/return \{ exe: staged, via: "bundled" \}/);
    /*
     * 允许"落位失败 ⇒ 退回内置路径"（能用优先），但那条路必须带警告 ——
     * 否则将来有人把落位整个删掉、只留退回分支，判据也照样绿（这正是要防的假绿）。
     */
    expect(branch, "退回内置路径时必须留下警告").toMatch(/console\.warn\([\s\S]{0,200}?内置 Node 落位到数据目录失败/);
  });

  it("OFM-UPGRADE-2：应用内升级前要先停掉插件（释放句柄，且不许把它禁用）", () => {
    expect(panel, "安装前要停插件").toMatch(/await freeModelPlugin\.stop\(\)/);
    expect(
      panel.indexOf("freeModelPlugin.stop()") < panel.indexOf("downloadWithRetry("),
      "顺序必须是：先 stop 再 downloadAndInstall",
    ).toBe(true);
    const stopRegion = panel.slice(panel.indexOf("第 212 波：安装前"), panel.indexOf("downloadWithRetry("));
    expect(stopRegion, "停掉不等于禁用：这里不许出现 pause").not.toContain("freeModelPlugin.pause");
  });

  it("OFM-UPGRADE-3（反假机制）：NSIS 钩子实测无效 ⇒ 不许留在配置里当挡箭牌", () => {
    /*
     * 这条不是"洁癖"：留着它会让人以为"已经处理了安装期占用"，
     * 而真机读数证明它**什么也没做**（占用进程存活、文件未被写入）。
     * 要重新引入它，必须同时带上"真机取证：占用进程被收掉 + 文件 mtime 被更新"。
     */
    expect(conf.bundle?.windows?.nsis?.installerHooks, "无效的钩子不许留在配置里").toBeFalsy();
  });
});
