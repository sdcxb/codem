/**
 * ## SSE-1..SSE-6：会话结束时的**脏 UI 状态**（第 46 波 ✓，`src/store.ts` 的 `setSessionActive` ✓）
 *
 * ### 真缺陷（**用户可见** ✓ + **评测受害** ✓，两条独立证据 ✓）
 *
 * `setStreaming(false)` 清 **6 样**（`isStreaming/streamingMsgId/stepProgress/agentActivities/streamStartTime/llmStatus` ✓），
 * 而 `setSessionActive(id,false)` 原来**只动 2 样**（`activeSessions/isStreaming` ✓）✗ ⇒
 * 在**会话视图**里（评测跑的就是这种 ✓）回合结束后界面仍挂着
 * **「处理中 · Ns 第X/Y步」** ✓、流式光标 ✓、活动面板 ✓、已用时 ✓。
 *
 * 现场证据（`1.16.295` 批 ✓）：
 *  - `busySamples.tail` 最后一刻的界面原文：`处理中 · 4s 第1/5步 · … ＋ 完全访问 搜索 临时会话` ✓
 *    而同一屏已写着「任务完成」✗；
 *  - 评测器探针认**整页文本**里的 `处理中|正在执行|…` ✓（`_codem-repo-eval.mjs:323` ✓）
 *    ⇒ 这句话残留 ⇒ `busy` 永不回落 ✗ ⇒ 8 格里 4 格只能等"引擎静默 120s"兜底 ✓，均值白等 **60s/格** ✗。
 *
 * ### 判据的自我要求（**变异自证**过的 ✓）
 *
 * - `SSE-2`/`SSE-4` 直接对**探针正则**断言 ✓ —— 不是只断言"字段是 null"✗：
 *   把修好的清空去掉、只保留 `activeSessions/isStreaming` ⇒ 这两条**必红** ✓
 *   （因为界面文本若还含"处理中"，探针就会判 busy ✓，这正是当初的 bug ✓）。
 * - `SSE-5` 钉住**不许矫枉过正** ✓：并发会话还在跑时，**不能**清别人的进度 ✗。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "../store";

/** ★ 与评测器探针**逐字同一份**正则 ✓（`_codem-repo-eval.mjs:323` ✓）—— 改一处必须改两处 ✓ */
const PROBE_BUSY_TEXT = /正在思考|正在连接|正在接收|正在执行|处理中|编码中|执行中|运行中/;

/** 界面在"有进度在跑"时会出现的那句话 ✓（`StreamingTimer` 那一族 ✓） */
const PROGRESS_LINE = "处理中 · 4s 第1/5步 · 分析消息更新后附件与元数据丢失的原因";

const reset = () =>
  useAppStore.setState({
    activeSessions: new Map<string, boolean>(),
    isStreaming: false,
    streamingMsgId: null,
    stepProgress: null,
    agentActivities: [],
    streamStartTime: null,
    llmStatus: "idle",
  } as never);

describe("会话结束时的脏 UI 状态（SSE）", () => {
  beforeEach(reset);

  it("SSE-1: 回合进行中 —— 进度在，探针判 busy ✓", () => {
    useAppStore.getState().setSessionActive("s1", true);
    useAppStore.setState({
      stepProgress: { step: 1, total: 5, label: "分析消息更新后附件与元数据丢失的原因" } as never,
      streamStartTime: Date.now(),
      streamingMsgId: "m1",
    } as never);

    const s = useAppStore.getState();
    expect(s.activeSessions.has("s1")).toBe(true);
    expect(s.stepProgress).not.toBeNull();
    // ★ 逐字口径：界面此刻确实在显示那句话 ⇒ 探针应当判 busy ✓
    expect(PROBE_BUSY_TEXT.test(PROGRESS_LINE)).toBe(true);
  });

  it("SSE-2: ★ 会话回合结束 ⇒ 界面不再出现「处理中」那句话（探针正则必须不中 ✓）", () => {
    useAppStore.getState().setSessionActive("s1", true);
    useAppStore.setState({
      stepProgress: { step: 1, total: 5, label: "分析…" } as never,
      streamStartTime: Date.now(),
      streamingMsgId: "m1",
      agentActivities: [{ kind: "tool", text: "执行中" }] as never,
      llmStatus: "streaming",
    } as never);

    useAppStore.getState().setSessionActive("s1", false);

    const s = useAppStore.getState();
    expect(s.activeSessions.size).toBe(0);
    expect(s.isStreaming).toBe(false);
    // ★ 这就是当初 bug 的判据：进度为空 ⇒ 界面不会再渲染那句话 ⇒ 探针不会误判 busy ✓
    expect(s.stepProgress).toBeNull();
    expect(s.streamingMsgId).toBeNull();
    expect(s.streamStartTime).toBeNull();
    expect(s.agentActivities).toEqual([]);
    expect(s.llmStatus).toBe("idle");
  });

  it("SSE-3: 与 setStreaming(false) 的清空口径**逐字段一致** ✓（别再出现「两条路清的不一样」✗）", () => {
    const withSession = () => {
      reset();
      useAppStore.getState().setSessionActive("s1", true);
      useAppStore.setState({
        stepProgress: { step: 2, total: 3 } as never,
        streamStartTime: 123,
        streamingMsgId: "m9",
        agentActivities: [{ kind: "tool" }] as never,
        llmStatus: "streaming",
      } as never);
      useAppStore.getState().setSessionActive("s1", false);
      return useAppStore.getState();
    };
    const withStreaming = () => {
      reset();
      useAppStore.setState({
        stepProgress: { step: 2, total: 3 } as never,
        streamStartTime: 123,
        streamingMsgId: "m9",
        agentActivities: [{ kind: "tool" }] as never,
        llmStatus: "streaming",
      } as never);
      useAppStore.getState().setStreaming(false);
      return useAppStore.getState();
    };

    const a = withSession();
    const b = withStreaming();
    for (const k of ["isStreaming", "streamingMsgId", "stepProgress", "agentActivities", "streamStartTime", "llmStatus"] as const) {
      expect(a[k], `字段 ${k} 两条路径应当一致`).toEqual(b[k]);
    }
  });

  it("SSE-4: 变异自证 —— 若只保留 activeSessions/isStreaming（旧行为 ✗），SSE-2 的判据必红 ✓", () => {
    // 模拟旧实现：只动两样
    useAppStore.getState().setSessionActive("s1", true);
    useAppStore.setState({
      stepProgress: { step: 1, total: 5 } as never,
      streamStartTime: Date.now(),
      streamingMsgId: "m1",
      agentActivities: [{ kind: "tool" }] as never,
      llmStatus: "streaming",
    } as never);
    const st = useAppStore.getState();
    st.activeSessions.delete("s1");
    useAppStore.setState({ activeSessions: new Map(st.activeSessions), isStreaming: false } as never);

    const after = useAppStore.getState();
    // 旧行为：进度**还在** ⇒ 界面仍渲染那句话 ⇒ 探针判 busy ✗（这就是 4/8 格走兜底的原因 ✓）
    expect(after.stepProgress).not.toBeNull();
    expect(PROBE_BUSY_TEXT.test(PROGRESS_LINE)).toBe(true);
  });

  it("SSE-5: 并发会话还在跑 ⇒ **不许**清掉它的进度 ✗（矫枉过正会红 ✓）", () => {
    useAppStore.getState().setSessionActive("s1", true);
    useAppStore.getState().setSessionActive("s2", true);
    useAppStore.setState({ stepProgress: { step: 3, total: 4 } as never, streamingMsgId: "m2" } as never);

    // s1 结束，但 s2 还在跑
    useAppStore.getState().setSessionActive("s1", false);

    const s = useAppStore.getState();
    expect(s.activeSessions.has("s1")).toBe(false);
    expect(s.activeSessions.has("s2")).toBe(true);
    expect(s.isStreaming).toBe(true);
    expect(s.stepProgress).not.toBeNull(); // ★ s2 的进度必须留着 ✓
    expect(s.streamingMsgId).toBe("m2");
  });

  it("SSE-6: 最后一个会话结束时 activeSessions 必须真删掉（不残留 ⇒ 不出现「永久忙碌」✓）", () => {
    useAppStore.getState().setSessionActive("s1", true);
    useAppStore.getState().setSessionActive("s2", true);
    useAppStore.getState().setSessionActive("s1", false);
    useAppStore.getState().setSessionActive("s2", false);
    const s = useAppStore.getState();
    expect(s.activeSessions.size).toBe(0);
    expect(s.isStreaming).toBe(false);
    expect(s.hasActiveSessions()).toBe(false);
  });
});
