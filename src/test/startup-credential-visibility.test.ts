/**
 * 启动期**凭据状态必须让用户看见**（第 89 轮）。
 *
 * ## 现场（第 88 轮隔离钻取，装机版真机取证）
 *
 * 副本库 + `CODEM_DB_PATH` 启动装机版，让"密钥解不开"这一幕真的发生。结果是：
 *
 * - 界面上**一条提示都没有**（横幅里那条是"凭据普查"的另一件事）；
 * - 只有控制台两行 `[secrets] N 个 provider 的密钥解不开…`；
 * - 用户唯一能看到的地方是**主动**打开「设置 → 安全」时那行
 *   「其中 N 个**本账户解不开**（密文已保留）——请重新填写这些 API Key」。
 *
 * 而这一句是 `console.warn` **看不见**的事：这些 provider 现在**用不了**
 * （界面显示已配置、请求却没有密钥）。仓库级契约是"失败必须可见"，
 * 所以这一条是**缺口**，不是"设计如此"。
 *
 * ## 判据
 *
 * - SCV-1：解不开 ⇒ **失败**通道，且带真实 `title` 与**下一步**（"重新填写"）；
 * - SCV-2：没封存成 ⇒ 失败通道（安全动作没生效），文案说明"仍是明文"；
 * - SCV-3：环境事实（没有系统加密）与字节残留 ⇒ **提醒**通道，不许说成失败；
 * - SCV-4：**一切正常时零上报**（开机不许打扰用户）—— 反向对照，防"修成永远报警"；
 * - SCV-5：`App.tsx` 必须真的调用它（结构判据：不许退回只有 `console.warn`）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportCredentialStartupIssues } from "../core/storage/credential-startup-report";
import { composePersistAlertText, resetPersistFailures } from "../core/storage/persist-failure";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const HYD_OK = { unsealed: 0, failed: 0, backend: true, settingsReady: true };
const MIG_OK = { sealed: 0, failed: 0, skippedUnavailable: 0, skippedByChoice: 0, cleanedDuplicate: 0 };

/** 跑一次并收集**界面上会印的那句话**（banner 文案）+ 通道记账 */
function runAndCollect(input: Parameters<typeof reportCredentialStartupIssues>[0]) {
  resetPersistFailures();
  const prevWarn = console.warn;
  const prevErr = console.error;
  const logs: string[] = [];
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  /**
   * 横幅文案的**唯一来源**是 `codem:persist-failed` 事件的 detail
   * （`title` / `consequence` 都在里面；通道记账只留 area/count/kind）。
   * 所以这里按 App.tsx 的做法监听事件再 `composePersistAlertText` ——
   * 这样测到的就是**界面上真会显示的那句话**。
   */
  const details: Array<Record<string, unknown>> = [];
  const on = (e: Event) => details.push((e as CustomEvent).detail as Record<string, unknown>);
  window.addEventListener("codem:persist-failed", on);
  let out: ReturnType<typeof reportCredentialStartupIssues>;
  try {
    out = reportCredentialStartupIssues(input);
  } finally {
    window.removeEventListener("codem:persist-failed", on);
    console.warn = prevWarn;
    console.error = prevErr;
  }
  const entries = details.map((d) => ({
    area: String(d.area ?? ""),
    kind: String(d.kind ?? ""),
    text: composePersistAlertText(d as never),
  }));
  return { out, entries, logs: logs.join("\n") };
}

describe("启动期凭据状态的可见性（第 89 轮）", () => {
  it("SCV-1 密钥解不开 ⇒ 走失败通道，文案带真实开头与「重新填写」这一步", () => {
    const { entries, logs } = runAndCollect({ hydrated: { ...HYD_OK, failed: 2 }, migrated: MIG_OK });
    const entry = entries.find((e) => e.area === "secrets.unseal");
    expect(entry, "解不开必须产生一条用户可见上报（真机取证时它只在控制台）").toBeTruthy();
    expect(entry?.kind, "这是失败：这些 provider 现在用不了").toBe("action");

    /**
     * ⚠️ 判据读的是**上报出去的那句话本身**（经事件 + `composePersistAlertText`），
     * 不是测试里另抄一份文案 —— 否则把源码里的下一步删掉，测试照样绿。
     * （第 88 轮的变异演练就抓到过一次同类问题：判据抄了文案而不是读产出。）
     */
    const text = entry?.text ?? "";
    expect(text, `界面上的开头必须是真话：${text}`).toContain("本机解不开已保存的密钥");
    expect(text, `必须给出可执行的下一步（重新填写 API Key）：${text}`).toContain("重新填写");
    expect(text, `必须说清后果（这些 provider 用不了）：${text}`).toContain("用不了");
    expect(text, `这句话不是「重试一下就好」：${text}`).not.toContain("请重试");
    expect(logs, "控制台那行仍然保留（日志是排查依据）").toContain("解不开");
  });

  it("SCV-2 明文没被封存 ⇒ 失败通道，且文案说明「仍是明文」", () => {
    const { entries } = runAndCollect({ hydrated: HYD_OK, migrated: { ...MIG_OK, failed: 1 } });
    const entry = entries.find((e) => e.area === "secrets.migrate");
    expect(entry?.kind, "安全动作没生效 = 失败").toBe("action");
    const text = entry?.text ?? "";
    expect(text, `必须说清密钥仍是明文：${text}`).toContain("明文");
    expect(text, `并给出建议（轮换）：${text}`).toContain("轮换");
    expect(text, `不许说成「数据丢了」：${text}`).not.toContain("重启应用后会丢失");
  });

  it("SCV-3 环境事实与字节残留 ⇒ 提醒通道（不许说成失败）", () => {
    const a = runAndCollect({ hydrated: HYD_OK, migrated: { ...MIG_OK, skippedUnavailable: 1 } });
    const adv1 = a.entries.find((e) => e.area === "secrets.noBackend");
    expect(adv1?.kind, "没有系统加密是环境事实，不是失败").toBe("advisory");

    const b = runAndCollect({
      hydrated: HYD_OK,
      migrated: { ...MIG_OK, sealed: 1 },
      residue: { attempted: true, vacuumed: false, reason: "磁盘忙" },
    });
    const adv2 = b.entries.find((e) => e.area === "secrets.residue");
    expect(adv2?.kind, "残留没回收是要人判断的风险，不是失败").toBe("advisory");
    expect(adv2?.text, "提醒文案里不许出现失败语气").not.toContain("请重试");
    expect(adv2?.text).toContain("行级封存**已经生效**");
  });

  it("SCV-4 反向对照：一切正常 ⇒ **零上报**（开机不许打扰用户）", () => {
    const r = runAndCollect({ hydrated: HYD_OK, migrated: MIG_OK });
    expect(r.out.reported, "正常路径不许产生任何上报").toBe(false);
    expect(r.entries, "正常路径不许有任何用户可见提示").toEqual([]);
    // 残留成功回收、用户显式选择明文 ⇒ 同样不打扰
    const r2 = runAndCollect({
      hydrated: HYD_OK,
      migrated: { ...MIG_OK, sealed: 1, skippedByChoice: 1 },
      residue: { attempted: true, vacuumed: true },
    });
    expect(r2.entries, "成功回收 / 用户显式选明文都不是异常").toEqual([]);
  });

  it("SCV-5 结构：App.tsx 必须调用它（不许退回只剩 console.warn）", () => {
    const app = read("src/App.tsx");
    expect(app, "凭据段必须调用 reportCredentialStartupIssues").toContain("reportCredentialStartupIssues({");
    expect(app, "必须把 residue 递进去（否则残留那条永远不会出现）").toMatch(/residue \? \{ residue \} : \{\}/);
    // 反向对照：这段里仍然要保留控制台日志（排查依据），不能"改成上报就删日志"
    const block = app.slice(app.indexOf("## 第 89 轮：这段状态**必须让用户看得见**") - 3000, app.indexOf("reportCredentialStartupIssues({"));
    expect(block, "控制台日志不许被删（日志与上报是两条腿）").toContain("[secrets]");
  });
});
