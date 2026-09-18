/**
 * useDraftPersistence — 草稿持久化 Hook
 *
 * 为每个对话保存独立的输入草稿，切换对话时自动恢复。
 *
 * ## 存储的不变量（第 54 轮）：`composer-draft-<key>` 存在 ⇔ 该会话有一份**非空**草稿
 *
 * 真机钻取发现的偏差：`settings` 里躺着 **24** 条 `composer-draft-*`，其中一批的会话
 * **早就不存在了**（我自己早期钻取的 `probe-paging` / `probe-loglag` 会话），
 * 值全是空串。两条成因，这一轮都堵掉：
 *
 * 1. **防抖定时器无条件写**：切到某个会话超过 500ms 就会给它的键写一条**空草稿**
 *    （哪怕用户一个字都没敲）—— 而下面的注释一直声称"遍历过的会话不该攒出无意义的行"：
 *    注释与实现对不上（`印出来的必须是真的`）。现在定时器也走同一个"值不值得写"判据；
 * 2. **清空草稿写空串**（发完消息 `clearDraft`、用户把字删光）：空串本身没有信息，
 *    现在直接**删掉那一行**（`removeSetting`），而不是留一条空记录。
 *
 * 会话被删除时那一行也会被清掉（`core/store.ts::deleteSession`，与第 47 轮清理
 * `codem-last-session` 同一个位置、同一个理由）。
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { getSetting, setSetting, removeSetting } from "../core/storage/settings";

/**
 * 草稿落盘：**空串 = 删除这一行**（见文件头的不变量）。
 *
 * 抽成模块级纯函数是为了让"写/删"两态只在一处判断 —— 三个调用点
 * （防抖、切换冲刷、`clearDraft`）语义必须完全一致。
 */
function persistDraft(key: string, value: string): void {
  if (value === "") removeSetting(`composer-draft-${key}`);
  else setSetting(`composer-draft-${key}`, value);
}

export function useDraftPersistence(draftKey: string | null) {
  const [draft, setDraft] = useState("");

  /**
   * "已经提交到 state 的这段文本属于哪个 key / 文本是什么"。
   *
   * P1-11 的坑（实测踩到过两个方向）：
   * - 只用 `draftKey` 的闭包值 → key 变化时 cleanup 拿到的是**旧** key，旧会话的字写不回去；
   * - 只读"当前 key" → 会把**旧会话**的文本写进**新会话**的键
   *   （实测：`composer-draft-new` 被写成旧的文本，并覆盖新会话已有的草稿）。
   * 所以 key 与文本必须成对维护，冲刷时用**这一对**。
   */
  const draftRef = useRef(draft);
  const draftKeyRef = useRef(draftKey);
  draftRef.current = draft;
  draftKeyRef.current = draftKey;

  /**
   * 已经落盘的那份草稿（key + 文本）。
   *
   * 跟 `draftRef` 分开的原因：`draft` 最初是空串，而"空串还没落盘过"和"空串已经落盘过"
   * 要区分开 —— 卸载时前者不该凭空建一条空草稿（遍历过的会话会攒出无意义的行），
   * 后者必须写回去（用户把输入框删空了这个动作本身要持久化）。
   *
   * 第 54 轮起：`storedValueRef` 的含义收紧为"**库里有没有这一行**"——
   * 空串不再落盘（会 `removeSetting`），所以落盘空串之后它记 `null`（= 没有行）。
   */
  const storedKeyRef = useRef<string | null>(null);
  const storedValueRef = useRef<string | null>(null);

  /** 记下"这个 key 现在落盘成了什么"（只碰 ref，因此下面的回调可以保持空依赖） */
  const rememberPersisted = (key: string, value: string) => {
    storedKeyRef.current = key;
    storedValueRef.current = value === "" ? null : value;
  };

  /** 冲刷回调的依赖要为空：它只读 ref，不能被 key/文本的闭包绑死在某一版 */
  const flushDraft = useCallback(() => {
    const key = draftKeyRef.current;
    if (!key) return;
    // 冲刷时以真正被编辑过的文本为准（stored 只用来判断"值不值得写"）
    persistDraft(key, draftRef.current);
    rememberPersisted(key, draftRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 立即写某个 key 的值（并同步"已落盘"记录） */
  const writeDraft = useCallback((key: string, value: string) => {
    persistDraft(key, value);
    rememberPersisted(key, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 改草稿。
   *
   * key 取 `draftKeyRef`（渲染期同步的最新 prop）：`InputArea` 里 `setDraft` 会被事件回调、
   * effect、`setTimeout` 等多处调用，闭包里的 `draftKey` 可能比真正的当前会话旧一版
   * —— 那种情况下把文本记到旧 key 上，就等于又串了一次会话。
   */
  const updateDraft = useCallback((value: string) => {
    const key = draftKeyRef.current;
    draftRef.current = value;
    setDraft(value);
    return key;
  }, []);

  // 加载草稿
  useEffect(() => {
    if (!draftKey) {
      updateDraft("");
      return;
    }
    const saved = getSetting(`composer-draft-${draftKey}`);
    const text = typeof saved === "string" ? saved : "";
    updateDraft(text);
    /**
     * 读到什么就是"已落盘"的基线，切换时据此判断要不要写。
     *
     * ⚠️ 空串一律记成 `null`：历史版本会给"只是路过"的会话留一条**空草稿行**，
     * 那些行在新语义下等于"没有草稿"（否则一进这个会话就会被判成"值得写"，
     * 又会把它写回去 —— 空行永远清不掉）。
     */
    storedKeyRef.current = draftKey;
    storedValueRef.current = text === "" ? null : text;
  }, [draftKey, updateDraft]);

  /**
   * 保存草稿（防抖 500ms）+ **卸载/切换会话立即冲刷**。
   *
   * P1-11：原来只有 `clearTimeout`，卸载/切换会把防抖窗口里的最后一次输入直接丢掉
   * （用户看到的字，切回会话就没了）。
   *
   * 两个必须同时成立的约束：
   * - **卸载**必须写（这是丢字的场景）；
   * - **切换会话**必须写回**旧** key（不能写进新 key）。
   * 所以在 cleanup 里判断"key 变了没有"，而不是在 effect 体里（effect 体里读到的
   * 是上一版的 ref，恰恰是旧 key，会写错地方 —— 实测过）。
   * 冲刷只写存储、**不 setState**，因此卸载后不会出现"更新已卸载组件"的告警。
   * 因为输入而触发的同 key 重跑不进冲刷分支，500ms 防抖语义保持不变。
   *
   * ⚠️ 第 54 轮：定时器里加了**与 cleanup 完全相同的"值不值得写"判据**。
   * 原来它无条件 `writeDraft(key, draftRef.current)` —— 于是"切到某个会话、一个字不敲、
   * 待满 500ms"就会给那个会话写一条**空草稿**（真机实证：`settings` 里 24 条
   * `composer-draft-*`，一部分的会话已经删掉了，值全是空串）。
   * 注释一直写着"遍历过的会话不该攒出无意义的行"，实现与之相反 —— 现在是实现对。
   */
  useEffect(() => {
    if (!draftKey) return;
    const keyWhenScheduled = draftKey;
    const worthWriting = () => draftRef.current !== "" || storedValueRef.current !== null;
    const timer = setTimeout(() => {
      if (worthWriting()) writeDraft(keyWhenScheduled, draftRef.current);
    }, 500);
    return () => {
      clearTimeout(timer);
      const keyChanged = storedKeyRef.current !== keyWhenScheduled;
      if (worthWriting() && (keyChanged || draftKeyRef.current === keyWhenScheduled)) {
        flushDraft();
      }
    };
  }, [draft, draftKey, flushDraft, writeDraft]);

  const clearDraft = useCallback(() => {
    const key = updateDraft("");
    if (key) writeDraft(key, "");
  }, [updateDraft, writeDraft]);

  /**
   * 对外保持原来的 `setDraft(text)` 形状（调用方是 `InputArea` 的多处 setter，
   * 不能改成"必须传 key"）——key 由 hook 内部从最新 prop 取，两者不会错位。
   */
  const setDraftValue = useCallback(
    (value: string) => {
      updateDraft(value);
    },
    [updateDraft],
  );

  return { draft, setDraft: setDraftValue, clearDraft, flushDraft };
}
