/**
 * 会话镜像预热判据（1.18.4）。
 *
 * 用户现场：多轮对话期间水位提示条一直不出现，重启 Codem 后才突然提示 100%。
 * 根因：启动时只 warm 了当时的 active session；新建/切换的会话没有镜像 ⇒
 * `isHiddenStateAuthoritative` 持续 false ⇒ 水位与自动压缩在当前进程里“永远未知”，
 * 重启后 active session 被 warm 才显示。
 *
 * 本文件守两件事：
 * | # | 判据 |
 * | --- | --- |
 * | WARM-1 | 异步端口下，`warmSessionMessageMirror` 会触发加载；加载完成后权威判据变 true |
 * | WARM-2 | `ChatPanel` 在 active session 变化时真的调用它（否则只在启动 warm 仍会复发） |
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { isHiddenStateAuthoritative, warmSessionMessageMirror } from "../core/storage/message";
import { createFakeStoragePort } from "./fake-storage-port";

async function tick() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
}

afterEach(() => setStoragePort(null));

describe("WARM：新建/切换会话必须预热消息镜像", () => {
  it("WARM-1: 异步加载窗口内预热，完成后权威隐藏状态就绪", async () => {
    const port = createFakeStoragePort({
      asyncLoad: true,
      seed: {
        messages: [
          {
            id: "m1",
            session_id: "s1",
            role: "user",
            content: "写一份文档",
            reasoning: null,
            timestamp: 1,
            model: null,
            status: "done",
            hidden: 0,
          },
        ],
      },
    });
    setStoragePort(port);

    warmSessionMessageMirror("s1");
    expect(isHiddenStateAuthoritative("s1"), "刚触发加载时镜像还没就绪，不能冒充权威").toBe(false);

    await tick();
    expect(isHiddenStateAuthoritative("s1"), "加载完成后必须转为权威").toBe(true);
  });

  it("WARM-2: ChatPanel 在 active session 变化时接线预热", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/components/ChatPanel.tsx"), "utf8");
    expect(src).toContain('from "../core/storage/message"');
    expect(src).toContain("warmSessionMessageMirror(activeSessionId)");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*warmSessionMessageMirror\(activeSessionId\);\s*\}, \[activeSessionId\]\)/);
  });
});
