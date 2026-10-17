/**
 * `docs/evidence` 体量棘轮（第 232 波）。
 *
 * ## 为什么要有这一条
 *
 * `docs/evidence/` 是**真机取证的图片 + README**，随每一波取证线性增长：
 * 第 231/232 波两个批次就已经 3 MB 量级。它进的是 git 历史 ——
 * 图片一旦提交就永久留在历史里，删掉也不会变小。没有上限的话，
 * 几十波之后仓库会变成"取证图片仓库"，clone 与归档成本都跟着涨。
 *
 * ## 口径（三条，全部只看文件系统，不调外部命令）
 *
 * 1. **总量 ≤ 10 MB**：当前 3.07 MB（3 个批次），留了约 3 倍的余量；
 * 2. **单批目录 ≤ 3 MB**：一批几十张截图就顶到上限，说明该裁剪了
 *    （取证要能复现，但不需要把每一步的整屏都留档）；
 * 3. **每个批次目录必须有 `README.md`**：取证可复现的最低要求是
 *    "这是什么时候、在哪个版本、点了什么、看到什么" —— 只有图没有说明，
 *    下一个人（或下一轮的自己）无法判断那张图证明的是哪件事。
 *
 * ## 为什么不用 `du`
 *
 * 判据必须**毫秒级**且跨平台一致：`fs.statSync` 累加几十个文件是微秒级；
 * 起一个 `du` 子进程既慢（几十毫秒起），又在 Windows / Git Bash / CI 上各有各的
 * 参数与输出格式。判据本身不该变成"环境探测器"。
 *
 * ## 报错要给"实际值 + 建议动作"
 *
 * 只写"超限了"等于把问题丢回给人猜。所以每条断言都把**实际 MB / 上限 MB /
 * 哪个目录**写进消息里，并给出建议动作（压缩图片 / 裁掉旧批次 / 把整段过程
 * 挪到发布附件而不是仓库）。
 *
 * ## 变异自证（本文件必须能变红）
 *
 * 在任一现存批次目录里造一个 4 MB 文件（例如 `head -c 4194304 /dev/zero > docs/evidence/<批次>/big.bin`）：
 *   · 「单批目录 ≤ 3 MB」必红；
 *   · 总量 3.07 + 4 ≈ 7.07 MB，仍在 10 MB 内 ⇒ 总量那条**不会**红 ——
 *     这正是两条阈值分开的意义（单批失控要能被单独抓住）。
 * 再把它塞到 11 MB 以上（或临时改 `TOTAL_LIMIT`）：总量那条也红。
 * 删除临时文件后恢复全绿。
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const EVIDENCE_DIR = path.join(ROOT, "docs", "evidence");

/** 总量上限：10 MB（当前约 3.07 MB） */
const TOTAL_LIMIT = 10 * 1024 * 1024;
/** 单批目录上限：3 MB */
const BATCH_LIMIT = 3 * 1024 * 1024;

const MB = 1024 * 1024;

function mb(bytes: number): string {
  return (bytes / MB).toFixed(2) + " MB";
}

/** 目录里的文件字节数（递归；只累加普通文件，符号链接按 statSync 的结果算） */
function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirBytes(full);
      continue;
    }
    // 只文件：目录本身不占体量（statSync 对目录返回的 size 是元数据，跨平台不可比）
    if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

/** 建议动作：超限时给人看的下一步（不是"请瘦身"这种空话） */
const ACTION_TOTAL =
  "建议动作：把旧批次的整屏截图压成 JPEG / 缩放到必要区域，或删掉已被新证据取代的图片；" +
  "整段过程性截图移到发布附件而不是仓库。";
const ACTION_BATCH =
  "建议动作：只保留能证明结论的那几张图（裁剪到关键区域、转 JPEG），删掉中间态截图；" +
  "取证要可复现，但不要求每一步都留整屏。";

describe("docs/evidence 体量棘轮", () => {
  it("EV-BUDGET-1: docs/evidence 目录必须存在（取证区是纳入版本管理的契约）", () => {
    expect(
      fs.existsSync(EVIDENCE_DIR),
      "缺少 docs/evidence 目录：它是真机取证的落点，不该被删；若确实要停用，请先改这条判据并说明替代位置。",
    ).toBe(true);
  });

  it("EV-BUDGET-2: 总量 ≤ 10 MB", () => {
    const total = dirBytes(EVIDENCE_DIR);
    expect(
      total,
      "docs/evidence 总量 " + mb(total) + " 超过上限 " + mb(TOTAL_LIMIT) + "。" + ACTION_TOTAL,
    ).toBeLessThanOrEqual(TOTAL_LIMIT);
  });

  it("EV-BUDGET-3: 每个批次目录 ≤ 3 MB", () => {
    const over: string[] = [];
    for (const entry of fs.readdirSync(EVIDENCE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bytes = dirBytes(path.join(EVIDENCE_DIR, entry.name));
      if (bytes > BATCH_LIMIT) over.push(entry.name + " = " + mb(bytes) + "（上限 " + mb(BATCH_LIMIT) + "）");
    }
    expect(over, "单批目录超限：" + over.join("；") + "。" + ACTION_BATCH).toEqual([]);
  });

  it("EV-BUDGET-4: 每个批次目录必须有非空 README.md（图 + 说明才叫取证）", () => {
    const missing: string[] = [];
    for (const entry of fs.readdirSync(EVIDENCE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const readme = path.join(EVIDENCE_DIR, entry.name, "README.md");
      if (!fs.existsSync(readme)) {
        missing.push(entry.name + "（无 README.md）");
        continue;
      }
      if (fs.statSync(readme).size === 0) missing.push(entry.name + "（README.md 是空文件）");
    }
    expect(
      missing,
      "批次目录缺少可复现说明：" + missing.join("；") +
        "。建议动作：补一份 README.md，写清版本 / 时间 / 复现步骤 / 每张图证明了什么。",
    ).toEqual([]);
  });
});
