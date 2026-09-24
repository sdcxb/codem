/**
 * 附件写入**不许抹掉正文**（第 92 轮，真机抓到的静默数据丢失）。
 *
 * ## 现场（隔离钻取，装机版实测）
 *
 * 给一条消息挂上真附件（`content` 有值）→ 应用重启 → 界面上附件条还在（元数据来自域镜像），
 * 但**点开取不到正文**；直接查库：那一行的 `content` 变成 **NULL**，`preview` 还在
 * （`attachments.list` 看得到，`attachments.content` 取不到）。
 *
 * 根因：`writeAttachmentsViaPort`（启动期的消息索引重建 / 回填 / 更新都会走到它）
 * 把 `content` 一起 upsert，而**读路径上的消息按设计不带正文**
 * （`attachmentsFromMirror` 只投影元数据）⇒ `content: undefined` → 引擎把它写成 NULL。
 * 外置附件更惨：`content` 是 `file:<路径>` 标记，抹掉之后那个文件就再也找不回来。
 *
 * ## 判据
 *
 * | 编号 | 判据 | 严格度 |
 * | --- | --- | --- |
 * | ATT-KEEP-1 | **内存里没有正文**时，写附件的行**不许带 `content` / `preview` 键** | 行为 |
 * | ATT-KEEP-2 | 内存里**有**正文时，必须照常写入（反向对照：别修成"永远不写正文"） | 行为 |
 * | ATT-KEEP-3 | 引擎侧前提必须成立：`replace` 是"先 UPDATE、没有再 INSERT" ⇒ 未提供的列保持原值 | 结构 |
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { createMessage } from "../core/storage/message";
import type { Message } from "../store";

const ROOT = join(__dirname, "..", "..");
const SESSION = "sess-att-keep";
let port: FakeStoragePort | null = null;

afterEach(() => {
  setStoragePort(null);
  port = null;
});

/** 取最后一次 attachments 的 upsert 行 */
function lastAttachmentRow(p: FakeStoragePort): Record<string, unknown> {
  const writes = p.__writes().filter(
    (w) => w.command === "crud.upsert" && (w.params as { table?: string })?.table === "attachments",
  );
  expect(writes.length, "应当有一次附件写入").toBeGreaterThan(0);
  const rows = (writes[writes.length - 1].params as { rows: Array<Record<string, unknown>> }).rows;
  return rows[0];
}

describe("附件写入不许抹掉正文（第 92 轮）", () => {
  it("ATT-KEEP-1 内存里没有正文 ⇒ 行里不许带 content / preview 键", () => {
    port = createFakeStoragePort({});
    setStoragePort(port);

    // 模拟**读路径**上的消息：附件只有元数据（正文不在内存里）
    const msg = {
      id: "m-nocontent",
      role: "user",
      content: "带附件但没有正文的消息",
      timestamp: 1000,
      attachments: [{ id: "att-nocontent", name: "x.txt", type: "file", size: 10, addedAt: 1 }],
    } as unknown as Message;
    createMessage(msg, SESSION);

    const row = lastAttachmentRow(port);
    expect(
      Object.keys(row),
      `行里出现了 content/preview —— 会把磁盘上那份正文抹成 NULL：${JSON.stringify(row)}`,
    ).not.toContain("content");
    expect(Object.keys(row)).not.toContain("preview");
    // 元数据仍然要写（否则界面上的名字/大小会丢）
    expect(row.name).toBe("x.txt");
    expect(row.id).toBe("att-nocontent");
  });

  it("ATT-KEEP-2 反向对照：内存里有正文 ⇒ 必须照常写入", () => {
    port = createFakeStoragePort({});
    setStoragePort(port);

    const msg = {
      id: "m-content",
      role: "user",
      content: "带附件且有正文的消息",
      timestamp: 2000,
      attachments: [{ id: "att-content", name: "y.txt", type: "file", content: "正文-在这里", size: 12, addedAt: 1 }],
    } as unknown as Message;
    createMessage(msg, SESSION);

    const row = lastAttachmentRow(port);
    expect(row.content, "有正文时必须写进去（否则刚上传的附件马上就看不到内容）").toBe("正文-在这里");
    /**
     * `preview` 对**小内联**附件本来就是 null（`externalizeIfLargeSync` 只在 `att.preview`
     * 有值或外置之后才给 preview）—— 这里只断言"键在行里"，即"有正文时这两列是被显式提供的"。
     */
    expect(Object.keys(row), "有正文时 content/preview 两列都要显式提供").toContain("preview");
  });

  it("ATT-KEEP-3 结构 + 引擎前提：靠的是「未提供的列保持原值」", () => {
    const src = readFileSync(join(ROOT, "src", "core", "storage", "message.ts"), "utf8");
    expect(src, "必须有 hasContent 判断").toMatch(/const hasContent = typeof stored\.content === "string" && stored\.content\.length > 0;/);
    expect(src, "必须用条件展开，把没有正文的情况排除在行之外").toMatch(
      /\.\.\.\(hasContent \? \{ content: stored\.content, preview: stored\.preview \} : \{\}\)/,
    );
    const crud = readFileSync(join(ROOT, "src-tauri", "codem-db", "src", "crud.rs"), "utf8");
    expect(crud, "引擎必须是「先 UPDATE、没有再 INSERT」，未提供的列才会保持原值").toContain("未提供的列保持原值");
  });
});
