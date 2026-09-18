/**
 * 写盘/操作失败的**常驻提示条**（第 47 轮补，UI/UX 审计 P1）
 *
 * ## 这个组件为什么必须存在
 *
 * "失败必须可见"是仓库级契约（`persist-failure.ts` 与 `App.tsx` 的注释都写着这一条），
 * 但那条契约在界面上**实际上没有落地**：
 *
 * - `reportPersistFailure` 的可见出口只有一条：`onPersistFail` 把消息塞进
 *   `addGuidanceMessage(...)`；
 * - 而 `guidanceMessages` 在界面上**唯一**的渲染点带着 `isSessionStreaming` 前置条件
 *   → 用户**空闲时**改会话标题失败、删项目失败、保存权限规则失败、新建会话写库失败，
 *   **界面什么都不显示**（只剩控制台里一行）；
 * - 更糟的是那条通道的语义是"**用户引导**"：提示被渲染成一条待接收的引导条，
 *   主按钮是「立刻引导」→ `interruptForGuidance` → **中断正在生成的回复**，
 *   而这条告警从来没进过引导队列，点下去只是把 AI 的回答打断、什么都不注入。
 *   把"出错了"渲染成"引导"是范畴错误。
 *
 * ## 设计要点
 *
 * - **与流式状态无关**：空闲时也显示（那正是大多数写失败发生的时刻）；
 * - **常驻直到用户关掉**：写失败意味着"这次改动重启后会丢"，一闪而过的 toast 不够；
 * - **同一区域合并**：`count > 1` 时显示累计次数（磁盘满时不要刷屏）；
 * - **两种语气分开**：`persist`（数据没写进去，重启会丢）用错误色并明确后果；
 *   `action`（这次操作没生效）用警告色 —— 两者的严重程度不一样，不该长得一样。
 */

import { AlertTriangle, X, Save } from "lucide-react";
import { useAppStore } from "../store";
import { useLang } from "../core/i18n/lang";

export function PersistFailureBanner() {
  const alerts = useAppStore((s) => s.persistAlerts);
  const dismiss = useAppStore((s) => s.dismissPersistAlert);
  const lang = useLang();
  const zh = lang === "zh";

  if (alerts.length === 0) return null;

  return (
    <div className="persist-alert-stack" role="alert" aria-live="assertive" data-testid="persist-alert-stack">
      {alerts.map((a) => (
        <div
          key={a.id}
          className={`persist-alert ${a.kind === "persist" ? "is-persist" : "is-action"}`}
          data-testid={`persist-alert-${a.area}`}
        >
          <span className="persist-alert-icon" aria-hidden="true">
            {a.kind === "persist" ? <Save size={16} /> : <AlertTriangle size={16} />}
          </span>
          <div className="persist-alert-body">
            <span className="persist-alert-text">{a.message}</span>
            {a.count > 1 && (
              <span className="persist-alert-count">
                {zh ? `（已累计失败 ${a.count} 次）` : `(failed ${a.count} times)`}
              </span>
            )}
          </div>
          <button
            type="button"
            className="persist-alert-close"
            onClick={() => dismiss(a.id)}
            aria-label={zh ? "关闭提示" : "Dismiss"}
            title={zh ? "关闭提示" : "Dismiss"}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
