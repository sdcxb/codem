/**
 * PPTAdapter — PPTEditor 适配器组件
 *
 * 职责:
 * 1. 从已有笔记内容加载 V2SlideDeck
 * 2. 支持 autoGenerate 模式: 调用 generatePPTContent 从知识库 AI 生成
 * 3. 生成前提供风格选择和画布尺寸选择
 * 4. 将编辑结果序列化保存
 * 5. 处理导出下载
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import PPTEditor from './PPTEditor';
import { generatePPTContent, deserializeSlideDeck, serializeSlideDeck, type V2SlideDeck } from '../../core/knowledge';
import { PPT_THEMES, createElementId } from '../../core/knowledge/ppt-types';
import {
  PPT_STYLES, PPT_FONTS, CANVAS_SIZES, STYLE_CATEGORY_LABELS,
  loadGoogleFonts, getStyleById,
  type PPTStyle, type CanvasSize, type StyleCategory,
} from '../../core/knowledge/ppt-styles';
import { isImageGenAvailable as checkImageGen } from '../../core/knowledge/ppt-image';

export interface PPTAdapterProps {
  notebookId: string;
  initialContent?: string;
  title: string;
  /** 是否在打开时自动调用 AI 生成 PPT */
  autoGenerate?: boolean;
  /** 选中来源 ID 列表 (空 = 全部来源) */
  sourceIds?: string[];
  onSave: (title: string, content: string) => void;
  onBack: () => void;
}

/** 生成阶段定义 */
const STAGES = [
  { key: 'loading',   label: '加载知识库',  icon: '📚' },
  { key: 'preparing', label: '准备请求',    icon: '⚙️' },
  { key: 'generating',label: 'AI 生成中',    icon: '✨' },
  { key: 'parsing',   label: '解析结构',    icon: '🔧' },
  { key: 'building',  label: '构建幻灯片',  icon: '🎨' },
  { key: 'imaging',   label: 'AI 配图',     icon: '🖼️' },
];

export function PPTAdapter({ notebookId, initialContent, title: initialTitle, autoGenerate = false, sourceIds, onSave, onBack }: PPTAdapterProps) {
  const [deck, setDeck] = useState<V2SlideDeck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressStage, setProgressStage] = useState<string>('loading');
  const [progressDetail, setProgressDetail] = useState<string>('');
  const [title, setTitle] = useState(initialTitle);

  // 生成前选择 UI 状态
  const [showConfig, setShowConfig] = useState(false);
  const [selectedStyleId, setSelectedStyleId] = useState('business-blue');
  const [selectedCanvasId, setSelectedCanvasId] = useState('16:9');
  const [slideCount, setSlideCount] = useState(8);
  const [styleFilter, setStyleFilter] = useState<StyleCategory | 'all'>('all');
  const [enableImages, setEnableImages] = useState(false);
  // 追踪组件是否已卸载，避免异步操作完成后更新已卸载组件的状态
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // 加载 Google 字体
  useEffect(() => {
    loadGoogleFonts();
  }, []);

  // 初始化: 从 content 加载、AI 生成配置、或创建空白
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // 1. 尝试从已有内容加载
      if (initialContent) {
        const parsed = deserializeSlideDeck(initialContent);
        if (parsed) {
          if (!cancelled) setDeck(parsed);
          return;
        }
      }

      // 2. 如果需要自动生成, 先显示配置面板
      if (autoGenerate) {
        if (!cancelled) setShowConfig(true);
        return;
      }

      // 3. 创建空白 deck
      if (!cancelled) {
        setDeck({
          title,
          theme: PPT_THEMES[0],
          slides: [{
            id: createElementId(),
            index: 0,
            elements: [],
            background: PPT_THEMES[0].backgroundColor,
            notes: '',
          }],
          canvasWidth: 1920,
          canvasHeight: 1080,
        });
      }
    }

    init();
    return () => { cancelled = true; };
  }, [initialContent, title, autoGenerate, notebookId]);

  const handleDeckChange = useCallback((newDeck: V2SlideDeck) => {
    setDeck(newDeck);
  }, []);

  const handleGenerate = useCallback(async () => {
    setShowConfig(false);
    setLoading(true);
    setError(null);
    setProgressStage('loading');
    setProgressDetail('');
    try {
      const generated = await generatePPTContent(
        notebookId, title, slideCount, selectedStyleId, selectedCanvasId, enableImages, sourceIds,
        (stage, detail) => {
          if (mountedRef.current) {
            setProgressStage(stage);
            if (detail) setProgressDetail(detail);
          }
        }
      );
      if (mountedRef.current) {
        setDeck(generated);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    }, [notebookId, title, slideCount, selectedStyleId, selectedCanvasId, enableImages, sourceIds]);

  const handleExportHTML = useCallback((html: string) => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [title]);

  const handleExportPPTX = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.pptx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [title]);

  const handleBack = useCallback(() => {
    if (deck) {
      const content = serializeSlideDeck(deck);
      onSave(title, content);
    }
    onBack();
  }, [deck, title, onSave, onBack]);

  // PPTX 导入 (P2-14)
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportPPTX = useCallback(async (file: File) => {
    setImporting(true);
    setImportError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const { importPPTX } = await import('../../core/knowledge/pptx-importer');
      const importedDeck = await importPPTX(arrayBuffer);
      setDeck(importedDeck);
      setTitle(importedDeck.title);
      setShowConfig(false);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
    setImporting(false);
  }, []);

  // 过滤风格列表
  const filteredStyles = useMemo(() => {
    if (styleFilter === 'all') return PPT_STYLES;
    return PPT_STYLES.filter(s => s.category === styleFilter);
  }, [styleFilter]);

  const categories: (StyleCategory | 'all')[] = ['all', 'light-pro', 'light-soft', 'light-minimal', 'dark-tech', 'dark-luxury', 'dark-sober', 'bold', 'vibrant', 'effect', 'magazine', 'warm', 'illustration', 'chinese', 'nature'];

  // ====== 生成配置面板 (风格选择 + 画布尺寸 + 页数) ======
  if (showConfig && !loading && !deck) {
    return (
      <div style={{ position: 'fixed', top: 36, left: 0, right: 0, bottom: 0, background: 'var(--bg-primary, #1e1e2e)', display: 'flex', flexDirection: 'column', zIndex: 10001, overflow: 'hidden' }}>
        {/* 顶部栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', background: 'var(--bg-secondary, #2a2a3c)', borderBottom: '1px solid var(--border-primary, #3a3a4c)', flexShrink: 0 }}>
          <button onClick={onBack} style={{ background: 'var(--bg-tertiary, #3a3a4c)', color: 'var(--text-primary, #e0e0e0)', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 'var(--fs-base)', transition: 'var(--transition-color)' }}>← 返回</button>
          <span style={{ color: 'var(--text-muted, #888)', fontSize: 'var(--fs-md)' }}>PPT Studio</span>
          <span style={{ color: 'var(--text-muted, #555)', margin: '0 4px' }}>/</span>
          <span style={{ color: 'var(--text-primary, #e0e0e0)', fontSize: 'var(--fs-md)' }}>{title}</span>
        </div>

        {/* 可滚动内容 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
          <div style={{ maxWidth: 1000, margin: '0 auto' }}>
            <h2 style={{ color: 'var(--text-primary, #e0e0e0)', fontSize: 'var(--fs-2xl)', marginBottom: 4 }}>选择演示风格</h2>
            <p style={{ color: 'var(--text-muted, #888)', fontSize: 'var(--fs-base)', marginBottom: 20 }}>选择风格、画布尺寸和页数，从知识库内容生成 PPT</p>

            {/* PPTX 导入入口 */}
            <div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 10, background: 'var(--bg-tertiary, #252535)', border: '1px solid var(--border-primary, #3a3a4c)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--text-secondary, #a0a0b0)', fontSize: 'var(--fs-base)', flex: 1 }}>
                📥 已有 PPTX 文件？直接导入编辑
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pptx"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleImportPPTX(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                style={{
                  padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 'var(--fs-base)',
                  background: importing ? 'var(--bg-hover, #3a3a4c)' : 'var(--accent, #7c6cf0)', color: 'var(--text-on-accent, #fff)',
                  opacity: importing ? 0.6 : 1,
                }}
              >
                {importing ? '导入中...' : '导入 PPTX'}
              </button>
            </div>
            {importError && (
              <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--error, #ff8080)', fontSize: 'var(--fs-sm)' }}>
                导入失败: {importError}
              </div>
            )}

            {/* 分类筛选 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
              {categories.map(cat => (
                <button key={cat} onClick={() => setStyleFilter(cat)} style={{
                  padding: '5px 14px', borderRadius: 16, border: '1px solid', cursor: 'pointer', fontSize: 'var(--fs-sm)',
                  background: styleFilter === cat ? 'var(--accent, #7c6cf0)' : 'transparent',
                  borderColor: styleFilter === cat ? 'var(--accent, #7c6cf0)' : 'var(--border-primary, #3a3a4c)',
                  color: styleFilter === cat ? 'var(--text-on-accent, #fff)' : 'var(--text-secondary, #a0a0b0)',
                  transition: 'all 0.15s',
                }}>
                  {cat === 'all' ? '全部' : STYLE_CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* 风格网格 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 28 }}>
              {filteredStyles.map(style => (
                <div key={style.id} onClick={() => setSelectedStyleId(style.id)} style={{
                  cursor: 'pointer', borderRadius: 10, overflow: 'hidden', transition: 'all 0.15s',
                  border: selectedStyleId === style.id ? '2px solid var(--accent, #7c6cf0)' : '2px solid var(--border-primary, #3a3a4c)',
                  background: 'var(--bg-tertiary, #252535)',
                }}>
                  {/* 预览色块 */}
                  <div style={{ height: 80, background: style.backgroundGradient || style.colors.background, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: '50%',
                      background: `linear-gradient(135deg, ${style.colors.primary}, ${style.colors.accent})`,
                      opacity: 0.8,
                    }} />
                    <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 'var(--fs-sm)', color: style.colors.text, background: 'rgba(0,0,0,0.3)', padding: '2px 8px', borderRadius: 4 }}>
                      {style.name}
                    </div>
                  </div>
                  {/* 描述 */}
                  <div style={{ padding: '8px 12px' }}>
                    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary, #e0e0e0)', fontWeight: 600 }}>{style.name}</div>
                    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted, #888)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{style.description}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* 画布尺寸 */}
            <h3 style={{ color: 'var(--text-primary, #e0e0e0)', fontSize: 'var(--fs-lg)', marginBottom: 10 }}>画布尺寸</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 24 }}>
              {CANVAS_SIZES.map(cs => (
                <div key={cs.id} onClick={() => setSelectedCanvasId(cs.id)} style={{
                  cursor: 'pointer', padding: '10px 12px', borderRadius: 8, textAlign: 'center', transition: 'all 0.15s',
                  border: selectedCanvasId === cs.id ? '2px solid var(--accent, #7c6cf0)' : '2px solid var(--border-primary, #3a3a4c)',
                  background: 'var(--bg-tertiary, #252535)',
                }}>
                  <div style={{ fontSize: 'var(--fs-2xl)', marginBottom: 4 }}>{cs.icon}</div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary, #e0e0e0)', fontWeight: 600 }}>{cs.name}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted, #888)', marginTop: 2 }}>{cs.description}</div>
                </div>
              ))}
            </div>

            {/* 页数 */}
            <h3 style={{ color: 'var(--text-primary, #e0e0e0)', fontSize: 'var(--fs-lg)', marginBottom: 10 }}>幻灯片页数</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <input type="range" min={3} max={20} value={slideCount}
                onChange={e => setSlideCount(parseInt(e.target.value))}
                style={{ flex: 1, maxWidth: 300 }}
              />
              <span style={{ color: 'var(--text-primary, #e0e0e0)', fontSize: 'var(--fs-lg)', fontWeight: 600, minWidth: 40 }}>{slideCount} 页</span>
            </div>

            {/* AI 配图 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24,
              padding: '12px 16px', borderRadius: 8, background: 'var(--bg-tertiary, #252535)',
              border: '1px solid var(--border-primary, #3a3a4c)', opacity: checkImageGen() ? 1 : 0.5,
            }}>
              <input type="checkbox" id="enable-images"
                checked={enableImages}
                onChange={e => setEnableImages(e.target.checked)}
                disabled={!checkImageGen()}
                style={{ width: 18, height: 18, cursor: 'pointer' }}
              />
              <label htmlFor="enable-images" style={{
                color: 'var(--text-primary, #e0e0e0)', fontSize: 'var(--fs-md)', cursor: checkImageGen() ? 'pointer' : 'not-allowed',
              }}>
                🖼️ 启用 AI 配图
                {!checkImageGen() && (
                  <span style={{ color: 'var(--text-muted, #888)', fontSize: 'var(--fs-sm)', marginLeft: 8 }}>
                    (需在设置中配置生图模型)
                  </span>
                )}
              </label>
            </div>

            {/* 生成按钮 */}
            <button onClick={handleGenerate} style={{
              padding: '12px 32px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--fs-md)', fontWeight: 600,
              background: 'linear-gradient(135deg, var(--accent, #7c6cf0), var(--accent-hover, #9d8cf5))',
              color: '#fff', transition: 'all 0.15s',
              boxShadow: '0 4px 20px rgba(124,108,240,0.3)',
            }}>
              ✨ 生成 PPT
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 加载中 — 动态进度反馈
  if (loading) {
    const currentStageIdx = STAGES.findIndex(s => s.key === progressStage);
    const isGenerating = progressStage === 'generating';
    return (
      <div style={{
        position: 'fixed', top: 36, left: 0, right: 0, bottom: 0, background: 'var(--bg-primary, #1e1e2e)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10001,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 420, width: '90%' }}>
          <div style={{
            width: 64, height: 64, margin: '0 auto 20px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent, #7c6cf0), var(--accent-hover, #9d8cf5))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, animation: 'ppt-pulse 1.5s ease-in-out infinite',
          }}>
            {STAGES[currentStageIdx]?.icon || '⏳'}
          </div>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 6, color: 'var(--text-primary, #e0e0e0)' }}>
            AI 正在生成 PPT
          </div>
          <div style={{ fontSize: 'var(--fs-base)', marginBottom: 20, color: 'var(--text-muted, #888)', minHeight: 20 }}>
            {progressDetail || STAGES[currentStageIdx]?.label || '请稍候...'}
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, justifyContent: 'center' }}>
            {STAGES.map((s, i) => (
              <div key={s.key} style={{
                height: 3, flex: 1, maxWidth: 60, borderRadius: 2,
                background: i <= currentStageIdx ? 'var(--accent, #7c6cf0)' : 'var(--border-primary, #333)',
                transition: 'background 0.3s ease',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
            {STAGES.map((s, i) => (
              <div key={s.key} style={{
                fontSize: 'var(--fs-xs)',
                color: i === currentStageIdx ? 'var(--accent, #7c6cf0)' : i < currentStageIdx ? 'var(--text-muted, #666)' : 'var(--text-faded, #444)',
                fontWeight: i === currentStageIdx ? 600 : 400, transition: 'all 0.3s ease',
              }}>
                {s.label}{i < STAGES.length - 1 ? ' ·' : ''}
              </div>
            ))}
          </div>
          {isGenerating && (
            <div style={{ marginTop: 16, fontSize: 'var(--fs-sm)', color: 'var(--text-faded, #555)', fontFamily: 'monospace' }}>
              <span style={{ animation: 'ppt-dots 1.4s steps(4) infinite', display: 'inline-block' }}>●●●</span>
            </div>
          )}
        </div>
        <style>{`@keyframes ppt-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.08); opacity: 0.85; } } @keyframes ppt-dots { 0% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; } }`}</style>
      </div>
    );
  }

  // 生成失败
  if (error) {
    return (
      <div style={{
        position: 'fixed', top: 36, left: 0, right: 0, bottom: 0, background: 'var(--bg-primary, #1e1e2e)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10001,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 500, width: '90%' }}>
          <div style={{ width: 48, height: 48, margin: '0 auto 16px', borderRadius: '50%', background: 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--fs-2xl)' }}>⚠️</div>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 8, color: 'var(--danger, #ff8080)' }}>生成失败</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted, #888)', marginBottom: 20, lineHeight: 1.6, textAlign: 'left', background: 'var(--bg-secondary, #2a2a3c)', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border-primary, #333)', maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={() => { setError(null); setShowConfig(true); }} style={{ padding: '8px 16px', background: 'var(--accent, #7c6cf0)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-base)' }}>重新配置</button>
            <button onClick={onBack} style={{ padding: '8px 16px', background: 'var(--bg-hover, #3a3a4c)', color: 'var(--text-secondary, #ccc)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-base)' }}>返回</button>
          </div>
        </div>
      </div>
    );
  }

  if (!deck) return null;

  return (
    <PPTEditor
      initialDeck={deck}
      onDeckChange={handleDeckChange}
      onExportHTML={handleExportHTML}
      onExportPPTX={handleExportPPTX}
      onBack={handleBack}
    />
  );
}

export default PPTAdapter;
