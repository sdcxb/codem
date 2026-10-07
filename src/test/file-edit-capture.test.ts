/**
 * **编辑前整文件捕获**的行为判据（第 46 波 ✓）。
 *
 * 钉住四件事 ✓：
 *   · 「编辑前」= **第一次**捕获的内容 ✓（再捕获不许把"改后的样子"当成"编辑前"✗）
 *   · 「被还原」= 现在的内容哈希与捕获一致 ✓（这是 B 项替代 per-iteration git 快照的**唯一依据** ✓）
 *   · **保守方向** ✓：读不到 / 超上限 / 没记过 ⇒ 一律**不说"还原了"** ✓（误报比漏报危险 ✗）
 *   · 不产生副作用 ✓（只读；不调 git ✓、不写盘 ✓、不发事件 ✓）
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileEditCapture } from "../core/environment/file-edit-capture";

let dir = "";
const f = (name: string) => join(dir, name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codem-edit-capture-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 ✓ */
  }
});

describe("编辑前整文件捕获（B 项前置 ✓）", () => {
  it("EC-1 捕获后**没改** ⇒ 判定为「与捕获一致」✓（= 被还原 ✓）", () => {
    const p = f("a.ts");
    writeFileSync(p, "export const a = 1;\n");
    const cap = new FileEditCapture();
    const rec = cap.capture(p);
    expect(rec?.sha1, "要记下内容哈希").toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(cap.isSameAsCaptured(p), "原样不动 = 一致").toBe(true);
    expect(cap.revertedPaths()).toEqual([p]);
  });

  it("EC-2 捕获后**改了** ⇒ 判定为「不一致」✓", () => {
    const p = f("b.ts");
    writeFileSync(p, "v1\n");
    const cap = new FileEditCapture();
    cap.capture(p);
    writeFileSync(p, "v2\n");
    expect(cap.isSameAsCaptured(p)).toBe(false);
    expect(cap.revertedPaths()).toEqual([]);
  });

  it("EC-3 **首次优先** ✓：先改再捕获，拿到的是**改后**那份 ⇒ 不许把后来的当「编辑前」✗", () => {
    const p = f("c.ts");
    writeFileSync(p, "original\n");
    const cap = new FileEditCapture();
    cap.capture(p);
    writeFileSync(p, "edited\n");
    const second = cap.capture(p); // 编辑过程中又"捕获"了一次 ✓
    expect(second?.sha1, "第二次必须返回最初那条").toBe(cap.get(p)?.sha1);
    writeFileSync(p, "original\n"); // 还原回最初 ✓
    expect(cap.isSameAsCaptured(p), "还原到最初 ⇒ 一致").toBe(true);
  });

  it("EC-4 同一内容改回不同字节数 ⇒ 也必须判为不一致 ✓（先比大小 ✓）", () => {
    const p = f("d.ts");
    writeFileSync(p, "abc\n");
    const cap = new FileEditCapture();
    cap.capture(p);
    writeFileSync(p, "abcd\n");
    expect(cap.isSameAsCaptured(p)).toBe(false);
  });

  it("EC-5 没记过 / 文件不存在 / 是目录 ⇒ 都不许报「还原」✗（保守 ✓）", () => {
    const cap = new FileEditCapture();
    expect(cap.isSameAsCaptured(f("nope.ts"))).toBe(false);
    expect(cap.capture(f("nope.ts")), "读不到要返回 null").toBeNull();
    expect(cap.capture(dir), "目录不是文件 ⇒ null").toBeNull();
  });

  it("EC-6 超上限 ⇒ 只记 oversized ✓，且**不许**断言一致 ✗", () => {
    const p = f("big.ts");
    writeFileSync(p, "x".repeat(64));
    const cap = new FileEditCapture({ maxBytes: 16 });
    const rec = cap.capture(p);
    expect(rec?.oversized, "要标 oversized").toBe(true);
    expect(rec?.sha1, "没读内容 ⇒ 空哈希").toBe("");
    expect(cap.isSameAsCaptured(p), "没读过内容 ⇒ 不能说一致").toBe(false);
  });

  it("EC-7 捕获后再删文件 ⇒ 不为「还原」✗（删了不等于回到原样 ✓）", () => {
    const p = f("e.ts");
    writeFileSync(p, "keep\n");
    const cap = new FileEditCapture();
    cap.capture(p);
    rmSync(p);
    expect(cap.isSameAsCaptured(p)).toBe(false);
  });

  it("EC-8 与 git 无关 ✓：整个过程不产生任何 git 目录/文件 ✓", () => {
    const p = f("g.ts");
    writeFileSync(p, "x\n");
    const cap = new FileEditCapture();
    cap.capture(p);
    expect(cap.size()).toBe(1);
    expect(cap.paths()).toEqual([p]);
    cap.clear();
    expect(cap.size()).toBe(0);
    expect(cap.isSameAsCaptured(p), "清空后不再有记录 ⇒ false").toBe(false);
  });
});
