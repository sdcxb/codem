/**
 * 消息里的链接点击：外部 URL 必须真的打开，文件路径必须走文件管理器（第 233 轮审计）。
 *
 * ## 修的是什么
 *
 * `MessageBubble` 的 markdown `a` 渲染器把**所有**链接都交给 `handleFileLinkClick`
 * （含 `https://` / `mailto:`），而 `handleFileLinkClick` 会 `preventDefault()`
 * ⇒ 链接的默认导航被吃掉 ⇒ 只剩 `openFileLink` 这一条路。
 *
 * 但 `openFileLink` 原先是：
 *
 * ```ts
 * const absPath = await resolveFilePath(rawHref);
 * if (!absPath) return;                       // ← 外部 URL 在这里就返回了
 * ...
 * if (/^https?:\/\//i.test(rawHref) || /^mailto:/i.test(rawHref)) { window.open(...); return; }
 *                                             // ↑ 永远到不了（死分支）
 * ```
 *
 * 而 `resolveFilePath` 第一条就是 `if (外部 URL) return ""` ⇒ `absPath` 为空 ⇒ 提前返回。
 * 净效果：**用户消息里贴的网址，点了没有任何反应**（不打开浏览器、也不报错）。
 *
 * ## 判据（能变红）
 *
 * - LNK-1：`openFileLink("https://…")` 必须调用系统打开（`plugin:shell|open`），
 *   且**不得**调用 `reveal_item_in_dir`（把网址当文件路径去文件管理器里找）；
 * - LNK-2：`mailto:` 同样必须打开；
 * - LNK-3：文件路径（绝对/相对）仍然走 `reveal_item_in_dir`（反向对照：别把文件当网址）；
 * - LNK-4：`handleFileLinkClick` 对 http 链接**不再** `preventDefault` 后什么都不做 ——
 *   即它必须把外部 URL 交给同一条可用通路（这里以 LNK-1 的行为为准）。
 *
 * 变异自证：把 `openFileLink` 里外部 URL 的分支挪回 `resolveFilePath` 之后 ⇒ LNK-1/2 立刻红。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openFileLink } from "../utils/file-link";

type InvokeArgs = { cmd: string; args?: Record<string, unknown> };

let calls: InvokeArgs[] = [];

function installTauri(opts: { failReveal?: boolean } = {}) {
  calls = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "reveal_item_in_dir" && opts.failReveal) throw new Error("not found");
    return null;
  });
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

function calledWith(cmd: string): InvokeArgs | undefined {
  return calls.find((c) => c.cmd === cmd || c.cmd === `plugin:${cmd}` || c.cmd.startsWith(cmd));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("消息链接 · 外部 URL 必须真的打开", () => {
  it("LNK-1: https 链接调用系统打开，且不当作文件路径去 reveal", async () => {
    const invoke = installTauri();
    await openFileLink("https://example.com/docs?a=1");

    // 任何"打开"通路（shell 插件 / 文件外部打开 / window.open）必须被调用到
    const opened = invoke.mock.calls.some(([cmd]) => /shell\|open|open_file_external/.test(String(cmd)));
    expect(opened, "https 链接没有被打开（死链）—— 应调用 plugin:shell|open").toBe(true);
    expect(
      invoke.mock.calls.some(([cmd]) => cmd === "reveal_item_in_dir"),
      "网址被当成文件路径去 reveal 了",
    ).toBe(false);
  });

  it("LNK-2: mailto 链接同样必须打开", async () => {
    const invoke = installTauri();
    await openFileLink("mailto:dev@example.com");
    const opened = invoke.mock.calls.some(([cmd]) => /shell\|open|open_file_external/.test(String(cmd)));
    expect(opened, "mailto 链接没有被打开（死链）").toBe(true);
  });

  it("LNK-3（反向对照）: 绝对文件路径仍走 reveal_item_in_dir，不当作网址", async () => {
    const invoke = installTauri();
    await openFileLink("C:\\ws\\src\\a.ts");
    const reveal = calledWith("reveal_item_in_dir");
    expect(reveal?.args?.path, "绝对路径应原样交给文件管理器").toBe("C:\\ws\\src\\a.ts");
    expect(
      invoke.mock.calls.some(([cmd]) => /shell\|open/.test(String(cmd))),
      "文件路径不该被交给浏览器打开",
    ).toBe(false);
  });

  it("LNK-3b（反向对照）: reveal 失败时回退到打开父目录", async () => {
    const invoke = installTauri({ failReveal: true });
    await openFileLink("C:\\ws\\src\\a.ts");
    const external = invoke.mock.calls.filter(([cmd]) => cmd === "open_file_external");
    expect(external.length, "reveal 失败必须有回退").toBeGreaterThan(0);
    expect(String(external[0][1]?.path)).toBe("C:\\ws\\src");
  });
});
