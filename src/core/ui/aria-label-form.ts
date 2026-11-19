/**
 * 给"只有视觉标签"的表单控件补可访问名（Batch 6C）。
 *
 * ## 现场
 *
 * 无障碍审计（`_unslop-a11y-audit.mjs`）在设置页量到 **35 个可交互元素没有可访问名**：
 * 绝大多数是「一个 `<label>` 文字 + 紧挨着的 `<input>`/`<select>`」，但 label 没有 `for`、
 * 控件也没有 `id` —— 视觉上一对，语义上毫无关系。屏幕阅读器只会念「编辑框」。
 *
 * ## 为什么用运行时补齐，而不是逐个改 TSX
 *
 * 设置页有 26 处 `<label>`，另有若干动态生成的字段。逐个人工加 `id`/`htmlFor` 会产生
 * 大量机械 diff，而且新加字段很容易忘记。这里用一个**幂等**的补齐函数：
 * 给每个没有 `for` 的 label 生成一个稳定 id，再把它**同组内**第一个没有可访问名的控件
 * 用 `aria-labelledby` 关联。函数只写 `aria-labelledby`/`id`（React 不渲染这两个属性时
 * 不会在 re-render 时把它们清掉），重复调用无副作用。
 *
 * ## 口径
 *
 * - 只在「同一容器」内配对：label 与控件必须是同一个 `.setting-group` / `.sp-row` /
 *   `.identity-*` 的直接或间接后代，找不到就不猜；
 * - 已经可访问（`aria-label` / `aria-labelledby` / 有 `id` 且被 `label[for]` 指向）的控件不动；
 * - 只处理 `input:not([type=hidden])`、`select`、`textarea`；
 * - 返回这次补了多少个（便于测试与日志）。
 */

const CONTROL_SELECTOR = "input:not([type='hidden']):not([type='button']):not([type='submit']), select, textarea";
const GROUP_SELECTOR = ".setting-group, .sp-row, .settings-row, .setting-row, .identity-options, .identity-emoji-grid";

let counter = 0;

function hasAccessibleName(el: Element): boolean {
  if ((el.getAttribute("aria-label") || "").trim()) return true;
  if ((el.getAttribute("aria-labelledby") || "").trim()) return true;
  const id = el.getAttribute("id");
  if (id && el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)) return true;
  /* 被 label 包住也算有名字 */
  if (el.closest("label")) return true;
  return false;
}

/** 在 root 内补齐；返回补齐数量 */
export function labelFormControls(root: ParentNode | null | undefined): number {
  if (!root) return 0;
  let fixed = 0;
  const labels = Array.from(root.querySelectorAll("label")).filter((label) => !label.getAttribute("for"));
  for (const label of labels) {
    /* 同一组里找控件：先看组容器，再退回父节点 */
    const group = label.closest(GROUP_SELECTOR) ?? label.parentElement;
    if (!group) continue;
    const control = Array.from(group.querySelectorAll(CONTROL_SELECTOR)).find((el) => !hasAccessibleName(el));
    if (!control) continue;
    let labelId = label.getAttribute("id");
    if (!labelId) {
      labelId = `codem-field-label-${++counter}`;
      label.setAttribute("id", labelId);
    }
    control.setAttribute("aria-labelledby", labelId);
    fixed += 1;
  }
  return fixed;
}

/**
 * 兜底：没有任何 label 的控件，用 placeholder / 邻近文字当名字。
 *
 * 为什么允许 placeholder 当名字：它比「编辑框」强得多（屏幕阅读器至少能念出用途），
 * 而真正合规的做法是给每个字段加 label —— 那需要逐个人工改 TSX，见账本 §6C 的未做项。
 * 已有名字的控件不动；返回这次补了多少个。
 */
export function labelFormControlsByFallback(root: ParentNode | null | undefined): number {
  if (!root) return 0;
  let fixed = 0;
  for (const el of Array.from(root.querySelectorAll(CONTROL_SELECTOR))) {
    if (hasAccessibleName(el) || el.hasAttribute("aria-labelledby")) continue;
    const placeholder = (el.getAttribute("placeholder") || "").trim();
    if (placeholder) {
      el.setAttribute("aria-label", placeholder);
      fixed += 1;
      continue;
    }
    /* 没有 placeholder：用同一行里的可见文字（≤ 40 字）当名字 */
    const row = el.closest(".sp-row, .field-row, .setting-group, .settings-row");
    const text = (row?.textContent || "").trim().replace(/\s+/g, " ");
    if (text && text.length <= 40) {
      el.setAttribute("aria-label", text);
      fixed += 1;
    }
  }
  return fixed;
}

/**
 * 持续补齐：初次立即跑一遍，之后监听新挂载的子树（会话/设置/弹窗都是异步挂载的，
 * 只在 App 挂载时跑一次会漏掉它们 —— 实测漏了 14 个输入）。
 *
 * 只对**新增节点**做两件事（label 配对 + placeholder 兜底），不观察属性变化，
 * 所以不会和 React 的渲染互相打架；200ms 合并一次，开销可忽略。
 */
export function installAutoAriaLabels(doc: Document = document): () => void {
  const run = (root: ParentNode) => {
    labelFormControls(root);
    labelFormControlsByFallback(root);
  };
  run(doc.body);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending: Element[] = [];
  const flush = () => {
    timer = null;
    for (const el of pending.splice(0)) {
      if (el.isConnected) run(el);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === 1) pending.push(node as Element);
      }
    }
    if (pending.length === 0 || timer) return;
    timer = setTimeout(flush, 200);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
