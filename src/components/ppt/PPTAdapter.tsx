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
      <div className="ppt-studio-screen">
        {/* 顶部栏 */}
        <div className="ppt-studio-topbar">
          <button onClick={onBack} className="ppt-studio-back-btn">← 返回</button>
          <span className="ppt-studio-crumb">PPT Studio</span>
          <span className="ppt-studio-crumb-sep">/</span>
          <span className="ppt-studio-title">{title}</span>
        </div>

        {/* 可滚动内容 */}
        <div className="ppt-studio-body">
          <div className="ppt-studio-inner">
            <h2 className="ppt-studio-h2">选择演示风格</h2>
            <p className="ppt-studio-lead">选择风格、画布尺寸和页数，从知识库内容生成 PPT</p>

            {/* PPTX 导入入口 */}
            <div className="ppt-studio-import-row">
              <span className="ppt-studio-import-text">
                📥 已有 PPTX 文件？直接导入编辑
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pptx"
                className="ppt-studio-hidden-input"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleImportPPTX(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="ppt-studio-import-btn"
              >
                {importing ? '导入中...' : '导入 PPTX'}
              </button>
            </div>
            {importError && (
              <div className="ppt-studio-error">
                导入失败: {importError}
              </div>
            )}

            {/* 分类筛选 */}
            <div className="ppt-studio-filters">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setStyleFilter(cat)}
                  className={`ppt-studio-filter ${styleFilter === cat ? 'is-active' : ''}`}
                >
                  {cat === 'all' ? '全部' : STYLE_CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* 风格网格 */}
            <div className="ppt-studio-style-grid">
              {filteredStyles.map(style => (
                <div
                  key={style.id}
                  onClick={() => setSelectedStyleId(style.id)}
                  className={`ppt-studio-style-card ${selectedStyleId === style.id ? 'is-active' : ''}`}
                >
                  {/* 预览色块 — 底色/球体渐变/文字色来自风格数据，按「只给动态值」保留内联 */}
                  <div
                    className="ppt-studio-style-preview"
                    style={{ background: style.backgroundGradient || style.colors.background }}
                  >
                    <div
                      className="ppt-studio-style-orb"
                      style={{ background: `linear-gradient(135deg, ${style.colors.primary}, ${style.colors.accent})` }}
                    />
                    <div className="ppt-studio-style-badge" style={{ color: style.colors.text }}>
                      {style.name}
                    </div>
                  </div>
                  {/* 描述 */}
                  <div className="ppt-studio-style-meta">
                    <div className="ppt-studio-style-name">{style.name}</div>
                    <div className="ppt-studio-style-desc">{style.description}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* 画布尺寸 */}
            <h3 className="ppt-studio-h3">画布尺寸</h3>
            <div className="ppt-studio-canvas-grid">
              {CANVAS_SIZES.map(cs => (
                <div
                  key={cs.id}
                  onClick={() => setSelectedCanvasId(cs.id)}
                  className={`ppt-studio-canvas-card ${selectedCanvasId === cs.id ? 'is-active' : ''}`}
                >
                  <div className="ppt-studio-canvas-icon">{cs.icon}</div>
                  <div className="ppt-studio-canvas-name">{cs.name}</div>
                  <div className="ppt-studio-canvas-desc">{cs.description}</div>
                </div>
              ))}
            </div>

            {/* 页数 */}
            <h3 className="ppt-studio-h3">幻灯片页数</h3>
            <div className="ppt-studio-count-row">
              <input type="range" min={3} max={20} value={slideCount}
                onChange={e => setSlideCount(parseInt(e.target.value))}
                className="ppt-studio-range"
              />
              <span className="ppt-studio-count-value">{slideCount} 页</span>
            </div>

            {/* AI 配图 */}
            <div
              className="ppt-studio-option-row"
              style={{ opacity: checkImageGen() ? 1 : 0.5 }}
            >
              <input type="checkbox" id="enable-images"
                checked={enableImages}
                onChange={e => setEnableImages(e.target.checked)}
                disabled={!checkImageGen()}
                className="ppt-studio-checkbox"
              />
              <label htmlFor="enable-images" className="ppt-studio-option-label">
                🖼️ 启用 AI 配图
                {!checkImageGen() && (
                  <span className="ppt-studio-option-hint">
                    (需在设置中配置生图模型)
                  </span>
                )}
              </label>
            </div>

            {/* 生成按钮 */}
            <button onClick={handleGenerate} className="ppt-studio-generate-btn">
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
      <div className="ppt-studio-screen ppt-studio-screen--center">
        <div className="ppt-studio-stage ppt-studio-stage--narrow">
          <div className="ppt-studio-orb">
            {STAGES[currentStageIdx]?.icon || '⏳'}
          </div>
          <div className="ppt-studio-heading">
            AI 正在生成 PPT
          </div>
          <div className="ppt-studio-detail">
            {progressDetail || STAGES[currentStageIdx]?.label || '请稍候...'}
          </div>
          <div className="ppt-studio-progress">
            {STAGES.map((s, i) => (
              <div
                key={s.key}
                className={`ppt-studio-progress-seg ${i <= currentStageIdx ? 'is-done' : ''}`}
              />
            ))}
          </div>
          <div className="ppt-studio-stages">
            {STAGES.map((s, i) => (
              <div
                key={s.key}
                className={`ppt-studio-stage-label ${
                  i === currentStageIdx ? 'is-current' : i < currentStageIdx ? 'is-done' : ''
                }`}
              >
                {s.label}{i < STAGES.length - 1 ? ' ·' : ''}
              </div>
            ))}
          </div>
          {isGenerating && (
            <div className="ppt-studio-dots">
              <span className="ppt-studio-dots-anim">●●●</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 生成失败
  if (error) {
    return (
      <div className="ppt-studio-screen ppt-studio-screen--center">
        <div className="ppt-studio-stage ppt-studio-stage--wide">
          <div className="ppt-studio-orb ppt-studio-orb--error">⚠️</div>
          <div className="ppt-studio-heading ppt-studio-heading--error">生成失败</div>
          <div className="ppt-studio-error-text">
            {error}
          </div>
          <div className="ppt-studio-actions">
            <button onClick={() => { setError(null); setShowConfig(true); }} className="ppt-studio-btn ppt-studio-btn--primary">重新配置</button>
            <button onClick={onBack} className="ppt-studio-btn ppt-studio-btn--ghost">返回</button>
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
