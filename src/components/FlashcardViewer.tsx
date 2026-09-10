/**
 * FlashcardViewer — 闪卡学习与复习组件
 *
 * 借鉴 Lumina Note 的闪卡功能, 自研实现:
 * - SM-2 间隔重复算法
 * - 翻卡交互
 * - 复习评分 (Again / Hard / Good / Easy)
 * - AI 生成闪卡
 *
 * 样式：第 14 波把内联样式收口成 `.flashcard-*` 具名类（见 src/styles.css）。
 */

import { useState, useEffect, useCallback } from 'react';
import { Layers, RotateCw, Plus, Trash2, Sparkles, Loader2 } from 'lucide-react';
import { ActionIcons } from '../core/icons/icon-map';
import {
  listFlashcards, getDueFlashcards, createFlashcard, deleteFlashcard,
  reviewFlashcard, listFlashcardsByNote, getDueFlashcardsByNote,
  type Flashcard, type ReviewRating,
} from '../core/knowledge/flashcard-store';
import { generateFlashcards } from '../core/knowledge';
import { useLang } from '../core/i18n/lang';

interface FlashcardViewerProps {
  notebookId: string;
  noteId?: string;
  onClose: () => void;
}

export function FlashcardViewer({ notebookId, noteId, onClose }: FlashcardViewerProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const CloseIcon = ActionIcons.close;

  const [cards, setCards] = useState<Flashcard[]>([]);
  const [dueCards, setDueCards] = useState<Flashcard[]>([]);
  const [mode, setMode] = useState<'list' | 'review' | 'create'>('list');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');

  const refresh = useCallback(() => {
    // C5: 如果提供了 noteId，只显示该笔记的闪卡
    if (noteId) {
      setCards(listFlashcardsByNote(noteId));
      setDueCards(getDueFlashcardsByNote(noteId));
    } else {
      setCards(listFlashcards(notebookId));
      setDueCards(getDueFlashcards(notebookId));
    }
  }, [notebookId, noteId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleStartReview = () => {
    const reviewPool = dueCards.length > 0 ? dueCards : cards;
    if (reviewPool.length === 0) return;
    setDueCards(reviewPool);
    setCurrentIdx(0);
    setShowAnswer(false);
    setMode('review');
  };

  const handleReview = (rating: ReviewRating) => {
    const card = dueCards[currentIdx];
    if (!card) return;
    reviewFlashcard(card.id, rating);
    if (currentIdx < dueCards.length - 1) {
      setCurrentIdx(currentIdx + 1);
      setShowAnswer(false);
    } else {
      setMode('list');
      refresh();
    }
  };

  const handleCreate = () => {
    if (!front.trim() || !back.trim()) return;
    createFlashcard({ notebookId, front: front.trim(), back: back.trim() });
    setFront(''); setBack('');
    refresh();
    setMode('list');
  };

  const handleAIGenerate = async () => {
    // 模型能力检测
    const { checkFeatureAvailability } = await import('../core/llm/capability-detector');
    const capCheck = checkFeatureAvailability('ai-flashcards');
    if (!capCheck.available) {
      alert(isZh ? capCheck.warnings[0]?.zh : capCheck.warnings[0]?.en);
      return;
    }

    setGenerating(true);
    try {
      // C5: 传递 noteId 以从特定笔记内容生成闪卡
      const cards = await generateFlashcards(notebookId, 15, noteId);
      for (const card of cards) {
        createFlashcard({ notebookId, noteId, front: card.front, back: card.back });
      }
      refresh();
    } catch (e) {
      console.error('AI flashcard generation failed:', e);
    } finally {
      setGenerating(false);
    }
  };

  // ========== Review Mode ==========
  if (mode === 'review' && dueCards.length > 0) {
    const card = dueCards[currentIdx];
    return (
      <div className="nb-dialog-overlay" onClick={onClose}>
        <div className="nb-dialog flashcard-dialog--review" onClick={(e) => e.stopPropagation()}>
          <div className="nb-dialog-header">
            <h3 className="nb-dialog-title">
              <Layers size={16} />
              {isZh ? '闪卡复习' : 'Flashcard Review'}
              <span className="flashcard-counter">
                {currentIdx + 1} / {dueCards.length}
              </span>
            </h3>
            <button className="nb-dialog-close" onClick={() => setMode('list')}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="flashcard-review-body">
            <div
              onClick={() => setShowAnswer(!showAnswer)}
              className="flashcard-card"
            >
              {!showAnswer ? (
                <>
                  <span className="flashcard-hint">
                    {isZh ? '问题' : 'Question'}
                  </span>
                  <p className="flashcard-front">{card.front}</p>
                  <span className="flashcard-hint--bottom">
                    {isZh ? '点击查看答案' : 'Click to reveal answer'}
                  </span>
                </>
              ) : (
                <>
                  <span className="flashcard-hint">
                    {isZh ? '答案' : 'Answer'}
                  </span>
                  <p className="flashcard-back">{card.back}</p>
                </>
              )}
            </div>
            {showAnswer && (
              <div className="flashcard-ratings">
                {([
                  { r: 'again' as ReviewRating, label: isZh ? '重来' : 'Again', color: 'var(--error)' },
                  { r: 'hard' as ReviewRating, label: isZh ? '困难' : 'Hard', color: 'var(--warning)' },
                  { r: 'good' as ReviewRating, label: isZh ? '良好' : 'Good', color: 'var(--success)' },
                  { r: 'easy' as ReviewRating, label: isZh ? '简单' : 'Easy', color: 'var(--accent)' },
                ]).map(({ r, label, color }) => (
                  <button
                    key={r}
                    onClick={() => handleReview(r)}
                    className="flashcard-rating-btn"
                    style={{ color }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ========== Create Mode ==========
  if (mode === 'create') {
    return (
      <div className="nb-dialog-overlay" onClick={onClose}>
        <div className="nb-dialog flashcard-dialog--create" onClick={(e) => e.stopPropagation()}>
          <div className="nb-dialog-header">
            <h3 className="nb-dialog-title"><Plus size={16} />{isZh ? '创建闪卡' : 'Create Flashcard'}</h3>
            <button className="nb-dialog-close" onClick={() => setMode('list')}><CloseIcon size={16} /></button>
          </div>
          <div className="flashcard-form">
            <div>
              <label className="flashcard-label">{isZh ? '正面（问题）' : 'Front (Question)'}</label>
              <textarea className="flashcard-textarea" value={front} onChange={(e) => setFront(e.target.value)} placeholder={isZh ? '输入问题...' : 'Enter question...'} />
            </div>
            <div>
              <label className="flashcard-label">{isZh ? '背面（答案）' : 'Back (Answer)'}</label>
              <textarea className="flashcard-textarea" value={back} onChange={(e) => setBack(e.target.value)} placeholder={isZh ? '输入答案...' : 'Enter answer...'} />
            </div>
            <div className="flashcard-form-actions">
              <button className="nb-btn-cancel" onClick={() => setMode('list')}>{isZh ? '取消' : 'Cancel'}</button>
              <button className="nb-btn-confirm" onClick={handleCreate} disabled={!front.trim() || !back.trim()}>{isZh ? '创建' : 'Create'}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ========== List Mode ==========
  return (
    <div className="nb-dialog-overlay" onClick={onClose}>
      <div className="nb-dialog flashcard-dialog--list" onClick={(e) => e.stopPropagation()}>
        <div className="nb-dialog-header">
          <h3 className="nb-dialog-title">
            <Layers size={16} />
            {isZh ? (noteId ? '笔记闪卡' : '闪卡') : (noteId ? 'Note Flashcards' : 'Flashcards')}
            <span className="nb-count-badge">{cards.length}</span>
          </h3>
          <button className="nb-dialog-close" onClick={onClose}><CloseIcon size={16} /></button>
        </div>
        <div className="flashcard-toolbar">
          <button className="nb-studio-btn flashcard-tool-btn" onClick={handleStartReview} disabled={cards.length === 0}>
            <RotateCw size={13} />
            {isZh ? `复习 (${dueCards.length})` : `Review (${dueCards.length} due)`}
          </button>
          <button className="nb-studio-btn flashcard-tool-btn" onClick={() => setMode('create')}>
            <Plus size={13} />
            {isZh ? '新建' : 'New'}
          </button>
          <button className="nb-studio-btn flashcard-tool-btn" onClick={handleAIGenerate} disabled={generating}>
            {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            {isZh ? (noteId ? '从笔记生成' : 'AI 生成') : (noteId ? 'From Note' : 'AI Generate')}
          </button>
        </div>
        <div className="flashcard-body">
          {cards.length === 0 ? (
            <div className="flashcard-empty">
              <Layers size={28} className="flashcard-empty-icon" />
              <p>{isZh ? '暂无闪卡，点击「新建」或「AI 生成」创建' : 'No flashcards yet. Click "New" or "AI Generate"'}</p>
            </div>
          ) : (
            <div className="flashcard-list">
              {cards.map((card) => {
                const isDue = card.nextReview <= Date.now();
                return (
                  <div key={card.id} className="flashcard-item">
                    <div className="flashcard-item-head">
                      <div className="flashcard-item-main">
                        <p className="flashcard-item-front">{card.front}</p>
                        <p className="flashcard-item-back">{card.back}</p>
                      </div>
                      <button onClick={() => { deleteFlashcard(card.id); refresh(); }} className="flashcard-item-delete">
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="flashcard-item-meta">
                      {isDue && <span className="flashcard-due">● {isZh ? '待复习' : 'Due'}</span>}
                      {card.repetitions > 0 && <span>{isZh ? `复习 ${card.repetitions} 次` : `${card.repetitions} reps`}</span>}
                      <span>{isZh ? `间隔 ${card.intervalDays} 天` : `${card.intervalDays}d interval`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
