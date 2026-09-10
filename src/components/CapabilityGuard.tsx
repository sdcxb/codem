/**
 * 模型能力提示组件
 *
 * 在功能入口检测当前模型是否支持所需能力，不支持时显示降级提示。
 * 纯前端检测，不发送网络请求。
 */

import { useState, useEffect, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ActionIcons } from '../core/icons/icon-map';
import { checkFeatureAvailability } from '../core/llm/capability-detector';
import { useLang } from '../core/i18n/lang';

interface CapabilityGuardProps {
  /** 功能标识，用于查找所需能力 */
  feature: string;
  /** 子元素 — 功能的实际 UI */
  children: ReactNode;
  /** 如果不可用，是否仍然渲染子元素（降级模式） */
  fallbackRender?: boolean;
  /** 降级时的回调 */
  onUnavailable?: () => void;
}

/**
 * 能力守卫组件 — 包裹功能入口，检测模型能力并显示提示
 *
 * 使用方式:
 * <CapabilityGuard feature="note-operations">
 *   <button onClick={handleAINoteOp}>AI 创建笔记</button>
 * </CapabilityGuard>
 */
export function CapabilityGuard({ feature, children, fallbackRender = true, onUnavailable }: CapabilityGuardProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const [check, setCheck] = useState<{ available: boolean; warnings: Array<{ zh: string; en: string }> } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const result = checkFeatureAvailability(feature);
    setCheck(result);
    if (!result.available && onUnavailable) {
      onUnavailable();
    }
  }, [feature]);

  if (!check) return <>{children}</>;

  if (!check.available && !dismissed) {
    return (
      <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '4px' }}>
        {fallbackRender && children}
        {check.warnings.map((w, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '6px',
              padding: '6px 10px',
              background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
              borderRadius: '6px',
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-secondary, #a0a0a8)',
              lineHeight: '1.4',
            }}
          >
            <AlertTriangle size={12} style={{ color: 'var(--warning)', marginTop: 2, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{isZh ? w.zh : w.en}</span>
            <button
              onClick={() => setDismissed(true)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, flexShrink: 0 }}
            >
              <ActionIcons.close size={12} />
            </button>
          </div>
        ))}
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * 轻量级能力检测 hook — 用于在事件处理函数中检测能力
 *
 * 使用方式:
 * const { canUse, warning } = useCapabilityCheck('note-operations');
 * if (!canUse) { showWarning(warning); return; }
 */
export function useCapabilityCheck(feature: string) {
  const [state, setState] = useState<{ canUse: boolean; warning: string | null }>({ canUse: true, warning: null });

  useEffect(() => {
    const result = checkFeatureAvailability(feature);
    setState({
      canUse: result.available,
      warning: result.warnings.length > 0 ? result.warnings[0].zh : null,
    });
  }, [feature]);

  return state;
}
