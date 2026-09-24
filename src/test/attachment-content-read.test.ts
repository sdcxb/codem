/**
 * 附件**正文**的读取路径（第 92 轮修的真缺陷）。
 *
 * ## 现场（隔离钻取，装机版 1.16.138 实测）
 *
 * 给一条消息挂上真附件（副本库 + `CODEM_DB_PATH` 启动装机版），界面上：
 *
 * - **元数据看得见**：`[message-attachments] live-attachment.txt 61 B`、`attachment-name` / `attachment-size` 都在；
 * - **点开是空的**：DOM 里没有出现正文（我塞进去的指纹串一次都没出现），也没有任何提示。
 *
 * 根因在 `MessageBubble`：它只读 `att.content`。而**读路径**上的消息（重启后 / 从域镜像读）
 * 按设计**不带正文**（`attachmentsFromMirror`：正文可能几十 MB，一律留空、按需取）
 * ⇒ "点开看正文"只在**刚上传那一刻**成立（那时正文还在内存缓存里），重启后永远是空框。
 *
 * ## 修法
 *
 * 点开时先看内存里的 `att.content`，没有就调 `getAttachmentContent(id)`
 * （同步缓存 → 命中即显示；未命中会触发一次异步预取），并用**有界重试**
 * （4 次、退避 400/800/1200/1600ms）等预取落地；一直读不到就**如实说**
 * "正文暂时读不到（已触发预取，再点一次可重试）"，而不是给一个永远空的框。
 *
 * ## 判据
 *
 * | 编号 | 判据 | 严格度 |
 * | --- | --- | --- |
 * | ATT-READ-1 | 组件必须走 `getAttachmentContent`（不许只读 `att.content`） | 结构 |
 * | ATT-READ-2 | 读不到必须有**如实提示**（不许渲染空框） | 结构 + 文案 |
 * | ATT-READ-3 | 重试必须**有界**且有清理（不许无限轮询 / 不许漏 clearTimeout） | 结构 |
 * | ATT-READ-4 | 反向对照：刚上传（内存里有 content）时**直接用**，不必等预取 | 行为 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = readFileSync(join(ROOT, "src", "components", "MessageBubble.tsx"), "utf8");

/** 只取附件那一段（避免把别处的 getLang/useEffect 当成判据） */
const attachmentBlock = (() => {
  const start = SRC.indexOf("message-attachments");
  const end = SRC.indexOf("P3: Image gallery lightbox");
  return SRC.slice(start, end > start ? end : start + 4000);
})();

describe("附件正文的读取路径（第 92 轮）", () => {
  it("ATT-READ-1 点开附件必须走 getAttachmentContent（只读 att.content 就是那个老缺陷）", () => {
    expect(SRC, "必须导入 getAttachmentContent").toMatch(/import\s*\{[^}]*getAttachmentContent[^}]*\}\s*from\s*"\.\.\/core\/storage\/message"/);
    expect(attachmentBlock, "点开时必须调用它").toContain("getAttachmentContent(att.id)");
    // ⚠️ 老写法：`showAttachment === att.id && att.content` —— 读路径上 content 为空 ⇒ 永远不展开内容
    expect(
      attachmentBlock,
      "不许回到「只按 att.content 判断能不能展开」的老写法（读路径上 content 为空）",
    ).not.toMatch(/showAttachment === att\.id && att\.content\b/);
  });

  it("ATT-READ-2 读不到要有如实提示（不许渲染一个永远空的框）", () => {
    expect(attachmentBlock, "要有 pending/读不到的提示文案").toContain("正在读取正文");
    expect(
      SRC,
      "读不到时要说清「再点一次」（与既有的「未预热→重试」约定一致）—— 提示文案写在那段有界重试里",
    ).toMatch(/正文暂时读不到（已触发预取，再点一次可重试）/);
    expect(attachmentBlock, "提示要有类名，便于样式与真机度量").toContain("attachment-preview--pending");
  });

  it("ATT-READ-3 重试要有界 + 清理（不许无限轮询、不许漏 clearTimeout）", () => {
    const effect = SRC.slice(SRC.indexOf("附件正文的**有界重试**"), SRC.indexOf("附件正文的**有界重试**") + 1400);
    expect(effect, "必须有尝试上限").toMatch(/tries\s*>=\s*4/);
    expect(effect, "必须有退避").toMatch(/400\s*\*\s*\(tries\s*\+\s*1\)/);
    expect(effect, "必须清理定时器").toContain("clearTimeout(timer)");
    expect(effect, "上限之后必须停下（把 pending 清空）").toMatch(/setPendingAttachment\(null\)/);
  });

  it("ATT-READ-4 反向对照：内存里有正文（刚上传）就不用等预取", () => {
    expect(attachmentBlock, "有 att.content 时应直接返回、不调预取").toMatch(/if \(att\.content \|\| att\.type === "image"\) return;/);
    // 图片走的是别的分支（gallery），不该被这次改动碰到
    expect(attachmentBlock, "图片分支必须原样保留").toContain("attachment-image");
  });
});
