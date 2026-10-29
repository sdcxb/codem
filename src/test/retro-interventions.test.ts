/**
 * P2-8：复盘只读报告（`tools/audit/retro-interventions.mjs`）的判据。
 *
 * 这个工具的失败形态**不是崩**，而是**数错**：把平台注入的提醒当成"人的介入"，
 * 报告就会指着一个不存在的循环让你去改规则。所以判据分两半：
 *
 * | # | 判据 | 防的形态 |
 * | --- | --- | --- |
 * | RETRO-1 | 六个角色各自能被认出来，且「之前/讨论」这类泛词不误报 | 关键词过宽 ⇒ 全是假阳性 |
 * | RETRO-2 | `[SYSTEM]` / `<system-reminder>` / 子代理消息一律不算人的介入 | 真机第一次跑出来 11 次假的 carry |
 * | RETRO-3 | 同一条消息的重复副本只算一次 | 计数虚高 |
 * | RETRO-4 | `sub-` 内部会话不计入 | 把子代理的话算成用户的介入 |
 * | RETRO-5 | 重复开场白能识别成 trigger 候选 | 漏掉"手动开同一类任务" |
 * | RETRO-6 | 示例片段截断 + 绝对路径抹掉 | 报告被贴进文档时泄漏本机路径 |
 */
import { describe, it, expect } from "vitest";

import {
  analyzeSessions,
  classifyIntervention,
  parseSessionLines,
  redactPaths,
  renderReport,
  EXAMPLE_MAX_CHARS,
} from "../../tools/audit/retro-interventions.mjs";

const ts = (n: number) => 1_700_000_000_000 + n;
const user = (content: string, n = 0) => ({ role: "user", content, timestamp: ts(n) });

describe("P2-8 复盘只读报告", () => {
  it("RETRO-1: 六个角色可识别；泛词不误报", () => {
    expect(classifyIntervention("继续")?.role).toBe("retry");
    expect(classifyIntervention("还是不行，再试一次")?.role).toBe("retry");
    expect(classifyIntervention("可以")?.role).toBe("approve");
    expect(classifyIntervention("好的")?.role).toBe("approve");
    expect(classifyIntervention("上次说的那个文件在哪")?.role).toBe("carry");
    expect(classifyIntervention("这段太啰嗦了")?.role).toBe("judge");
    expect(classifyIntervention("我手动点一下就好了")?.role).toBe("stand-in");

    expect(classifyIntervention("我们在讨论架构"), "泛词不该被当成介入").toBeNull();
    expect(classifyIntervention("这件事之前没有做过"), "单独的「之前」不收（太宽）").toBeNull();
    expect(classifyIntervention("继续做这个功能的第二部分，注意别动别的模块"), "长句不是「继续」型重试").toBeNull();
  });

  it("RETRO-2: 平台注入的提醒不算人的介入", () => {
    // 分类器只看文本（「[SYSTEM] 还是不行」里有「还是不行」），过滤发生在会话分析层
    expect(classifyIntervention("[SYSTEM] 还是不行")?.role).toBe("retry");
    const report = analyzeSessions([
      {
        id: "s1",
        messages: [
          user("[SYSTEM] 还是不行", 1),
          user("[SYSTEM] 还是不行", 2),
          user("<system-reminder>继续</system-reminder>", 3),
          user("[子智能体完成通知] 还是不行", 4),
          user("可以", 5),
        ],
      },
    ]);
    expect(report.totalInterventions, "只该剩下那条真正的人话").toBe(1);
    expect(report.perRole.approve).toBe(1);
    expect(report.perRole.retry).toBe(0);
  });

  it("RETRO-3/RETRO-4: 重复副本只算一次；sub- 内部会话不计入", () => {
    const report = analyzeSessions([
      { id: "s1", messages: [user("可以", 1), user("可以", 2), user("可以 ", 3)] },
      { id: "sub-abc", messages: [user("继续", 1), user("继续", 2)] },
    ]);
    expect(report.perRole.approve).toBe(1);
    expect(report.perRole.retry).toBe(0);
    expect(report.sessions).toBe(2);
  });

  it("RETRO-5: 两个会话用同一个开场白 ⇒ trigger 候选（首条是应答时取第一条实质内容）", () => {
    const report = analyzeSessions([
      { id: "a", messages: [user("帮我修一下登录页的报错", 1), user("可以", 2)] },
      { id: "b", messages: [user("帮我修一下登录页的报错！", 1)] },
      // 续跑会话：第一条是「继续」，真正的话题在第二条 —— 不能因此漏掉配对
      { id: "d", messages: [user("继续", 1), user("帮我修一下登录页的报错", 2)] },
      { id: "c", messages: [user("写个 README", 1)] },
    ]);
    expect(report.repeatedOpenings.length).toBe(1);
    expect(report.repeatedOpenings[0].sessions.sort()).toEqual(["a", "b", "d"]);
  });

  it("RETRO-6: 示例截断，绝对路径被抹掉", () => {
    expect(redactPaths("打开 C:\\Users\\abee\\secret\\a.ts 看看")).toBe("打开 <path> 看看");
    expect(redactPaths("see /home/abee/x/log.txt")).toBe("see <path>");

    const long = `我手动把 C:\\Users\\abee\\proj\\a.ts 复制过去了${"再".repeat(100)}`;
    const hit = classifyIntervention(long);
    expect(hit?.role).toBe("stand-in");
    expect(hit?.example.length).toBeLessThanOrEqual(EXAMPLE_MAX_CHARS);
    expect(hit?.example).not.toContain("C:\\Users");
  });

  it("解析 JSONL 时坏行跳过但不丢整份", () => {
    const { messages, broken } = parseSessionLines([
      JSON.stringify(user("继续", 1)),
      "{ this is not json",
      "",
      JSON.stringify(user("可以", 2)),
    ]);
    expect(messages).toHaveLength(2);
    expect(broken).toBe(1);
  });

  it("报告里带原文片段与「候选不是结论」的边界说明", () => {
    const report = analyzeSessions([{ id: "s1", messages: [user("继续", 1)] }]);
    const markdown = renderReport(report, { dir: "C:\\Users\\abee\\AppData\\sessions" });
    expect(markdown).toContain("启发式候选，不是结论");
    expect(markdown).toContain("<path>");
    expect(markdown).not.toContain("C:\\Users");
    expect(markdown).toContain("retry");
  });
});
