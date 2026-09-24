/**
 * 「发现 ≠ 失败」通道门禁（第 88 轮）。
 *
 * ## 现场（隔离钻取跑在装机版 1.16.134 上量到的原文）
 *
 * 把库复制一份、用引擎 CLI 在**副本**上把 `apiKeySealed` 换成解不开的密文，
 * 再用 `CODEM_DB_PATH` 指向副本启动装机版，于是生产路径真的跑到了"密钥解不开 +
 * 凭据普查命中 + 自检发现新缺口"。界面上印出来的是：
 *
 * ```text
 * 安全提示：设置里存在明文凭据：设置里存在疑似凭据 1 处。该功能本次不可用，请重试或检查日志。
 * ```
 *
 * ```text
 * [PersistFailure] maintenance.invariantAudit.new 写盘失败（第 1 次）：不变量审计：本次新产生 39 条缺口（…）
 *   —— 本次改动只存在于内存，重启后可能丢失。
 * ```
 *
 * 这几句里假的东西：**"该功能本次不可用"**（普查刚跑成功了）、
 * **"请重试"**（再跑一次还是同样的发现）、**"写盘失败"**（没有任何写盘动作失败）、
 * **"本次改动只存在于内存"**（没有改动）。发现类消息被套进失败模板，
 * 结果是两头的损失：**真问题被说成"重试一下就好"，假结论又让整条横幅不可信。**
 *
 * ## 判据
 *
 * - ADV-1：`advisory` 的横幅文案**不含**失败语气（"请重试"/"不可用"/"失败"/"重启应用后会丢失"）；
 * - ADV-2：控制台走 `[Advisory]`（**warn**，不是 error），且不出现"写盘失败/操作失败"；
 * - ADV-3：`persist` / `action` 的语气**不许被改坏**（反向对照：原来那两句必须还在）；
 * - ADV-4：结构判据 —— 四个"发现"站点必须走 `reportAdvisory`（不许回退成失败通道）；
 * - ADV-5：`PersistAlert.kind` 与 `App.tsx` 的事件监听必须**透传** `advisory`
 *   （原来监听器把非 action 一律折成 persist ⇒ 界面上渲染成"数据保存失败"）；
 * - ADV-6：次数后缀对 advisory 不说"已累计失败"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composePersistAlertText,
  getPersistFailures,
  reportAdvisory,
  reportPersistFailure,
  resetPersistFailures,
} from "../core/storage/persist-failure";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("「发现 ≠ 失败」通道（第 88 轮）", () => {
  it("ADV-1 提醒文案里不许出现失败语气（那几句都是假的）", () => {
    const text = composePersistAlertText({
      area: "maintenance.credentialCensus",
      message: "设置里存在疑似凭据 3 处",
      count: 1,
      kind: "advisory",
      title: "安全提示：发现疑似明文凭据",
      consequence: "若该机器或其备份可能外流，建议轮换；值从不打印。",
    });
    expect(text).toContain("疑似明文凭据");
    expect(text).toContain("建议轮换");
    for (const bad of ["请重试", "不可用", "失败", "重启应用后会丢失", "检查磁盘空间"]) {
      expect(text, `提醒文案里出现了失败语气「${bad}」：${text}`).not.toContain(bad);
    }
  });

  it("ADV-2 控制台：走 [Advisory] + warn，且不印「写盘失败/操作失败」", () => {
    resetPersistFailures();
    const warns: string[] = [];
    const errors: string[] = [];
    const ow = console.warn;
    const oe = console.error;
    console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      reportAdvisory("maintenance.invariantAudit.new", "本次新产生 2 条缺口", {
        title: "存储自检：本次新发现记录与界面不一致",
        nextStep: "不影响本次使用，但需要看一眼样例对应的会话。",
        sample: "样例：s1|RECORDED_BUT_NOT_VISIBLE",
      });
    } finally {
      console.warn = ow;
      console.error = oe;
    }
    expect(errors, `发现类消息不许打 error：${errors.join(" | ")}`).toEqual([]);
    const line = warns.join("\n");
    expect(line, `控制台必须标 [Advisory]：${line}`).toContain("[Advisory]");
    expect(line).toContain("本次新产生 2 条缺口");
    expect(line).toContain("样例：s1|RECORDED_BUT_NOT_VISIBLE");
    for (const bad of ["写盘失败", "操作失败", "第 1 次", "[PersistFailure]"]) {
      expect(line, `控制台里出现了失败措辞「${bad}」：${line}`).not.toContain(bad);
    }
    // 通道本身也要如实记账：kind = advisory（不是 persist/action）
    const entry = getPersistFailures().find((e) => e.area === "maintenance.invariantAudit.new");
    expect(entry?.kind).toBe("advisory");
  });

  it("ADV-3 反向对照：persist / action 的语气不许被这次改动改坏", () => {
    const persist = composePersistAlertText({ area: "a", message: "写不进去", count: 1, kind: "persist" });
    expect(persist).toContain("数据保存失败（a）");
    expect(persist).toContain("重启应用后会丢失");

    const action = composePersistAlertText({ area: "b", message: "没生效", count: 1, kind: "action" });
    expect(action).toContain("操作没有生效（b）");
    expect(action).toContain("该功能本次不可用，请重试或检查日志");

    // 次数后缀也各有各的说法
    const advCount = composePersistAlertText({ area: "c", message: "发现 3 处", count: 3, kind: "advisory" });
    expect(advCount).toContain("同类提示 3 次");
    expect(advCount).not.toContain("已累计失败");
  });

  it("ADV-4 结构：四个「发现」站点必须走 reportAdvisory（而「没跑成」仍然是失败）", () => {
    const maint = read("src/core/storage/maintenance.ts");

    /** 抓出文件里所有上报调用（连括号一起取全，避免只看第一处就下结论） */
    const calls: { kind: string; body: string }[] = [];
    const re = /report(PersistFailure|ActionFailure|Advisory)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(maint))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < maint.length && depth > 0) {
        if (maint[i] === "(") depth++;
        else if (maint[i] === ")") depth--;
        i++;
      }
      calls.push({ kind: m[1], body: maint.slice(m.index, i) });
    }
    const channelOf = (needle: string) => {
      const hit = calls.filter((c) => c.body.includes(needle));
      expect(hit.length, `找不到含「${needle}」的上报调用（判据过期了？）`).toBeGreaterThan(0);
      return [...new Set(hit.map((c) => c.kind))].join("+");
    };

    // 发现类（自检/普查跑成了，报的是结果）
    expect(channelOf("设置里存在疑似凭据"), "凭据普查的发现").toBe("Advisory");
    expect(channelOf("不变量审计：本次新产生"), "自检发现的新缺口").toBe("Advisory");
    expect(channelOf("事件库结构异常"), "事件库结构异常").toBe("Advisory");
    expect(channelOf('"maintenance.indexBehindLog"'), "索引落后于日志（已自动补回）").toBe("Advisory");

    // 反向对照：真的没跑成 / 真的失败，仍然必须是失败通道（别把这一类也搬走）
    expect(channelOf("事件结构自检未跑成"), "没跑成就是失败").toBe("PersistFailure");
    expect(channelOf("运行时不变量审计未跑成"), "没跑成就是失败").toBe("PersistFailure");
    expect(channelOf("遥测裁剪失败"), "裁剪失败就是失败").toBe("PersistFailure");
  });

  it("ADV-6 控制台标签优先用调用方给的真实开头（title）", () => {
    resetPersistFailures();
    const errors: string[] = [];
    const oe = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      // 带 title：标签用 title（因为"写盘失败"在维护类失败里是假话）
      reportPersistFailure("maintenance.integrityCheck", new Error("页 3 校验不过"), "已留重建标记", {
        title: "维护：完整性检查未跑成",
        consequence: "已留重建标记。",
      });
      // 不带 title：保持既有行为（既有调用点一个字都不变）
      reportPersistFailure("store.updateSession", new Error("disk full"));
    } finally {
      console.error = oe;
    }
    const line = errors.join("\n");
    expect(line, `控制台该用 title 当标签：${line}`).toContain("maintenance.integrityCheck 维护：完整性检查未跑成（第 1 次）");
    expect(line, "维护类失败不该被印成写盘失败").not.toContain("integrityCheck 写盘失败");
    expect(line, "没有 title 的调用点行为不许变").toContain("store.updateSession 写盘失败");
  });

  it("ADV-7 结构：维护里每处失败上报都必须给出真实的开头（title）", () => {
    const maint = read("src/core/storage/maintenance.ts");
    const missing: string[] = [];
    const re = /reportPersistFailure\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(maint))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < maint.length && depth > 0) {
        if (maint[i] === "(") depth++;
        else if (maint[i] === ")") depth--;
        i++;
      }
      const body = maint.slice(m.index, i);
      if (!/title:/.test(body)) missing.push(body.replace(/\s+/g, " ").slice(0, 110));
    }
    expect(
      missing,
      "这些维护类失败上报没有给 `title` —— 于是横幅与日志会用「数据保存失败/写盘失败」这种**假的**开头\n" +
        "（真机取证：完整性检查没跑成印成「写盘失败」；裁剪/回收/自检没跑成同理）：\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("ADV-5 结构：advisory 必须一路透传到界面（store 类型 + App 监听器两处）", () => {
    const store = read("src/store.ts");
    expect(store, "PersistAlert.kind 没带上 advisory").toMatch(/kind:\s*"persist"\s*\|\s*"action"\s*\|\s*"advisory"/);

    const app = read("src/App.tsx");
    const anchor = app.indexOf('window.addEventListener("codem:persist-failed"');
    expect(anchor, "找不到 persist-failed 监听器").toBeGreaterThan(0);
    const listener = app.slice(anchor - 2500, anchor);
    /**
     * 监听器里有**两处** kind 推导：一处进 store（决定横幅的样式与后缀），
     * 一处进 `composePersistAlertText`（决定文案）。
     * 只透传一处是不够的：横幅会变成"advisory 的颜色 + 失败的语气"（或反之）。
     */
    const advisoryPasses = listener.match(/detail\?\.kind === "advisory"/g) ?? [];
    expect(advisoryPasses.length, `监听器里只透传了 ${advisoryPasses.length} 处 advisory（应为 2 处：store + 文案）`).toBe(2);

    const banner = read("src/components/PersistFailureBanner.tsx");
    expect(banner, "横幅要有 advisory 的样式类").toContain("is-advisory");
    expect(banner, "横幅的「已累计失败 N 次」后缀对 advisory 是假的").toContain("同类提示");
  });
});
