/**
 * QuickPhraseSelector — 快捷短语选择器
 *
 * 显示模板化输入列表，分类展示，点击插入到输入框
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";
import type { QuickPhrase } from "../core/storage/settings";

interface QuickPhraseSelectorProps {
  /** Available phrases */
  phrases: QuickPhrase[];
  /** When user selects a phrase */
  onSelect: (content: string) => void;
  /** Close selector */
  onClose: () => void;
}

export const QuickPhraseSelector = memo(function QuickPhraseSelector({
  phrases,
  onSelect,
  onClose,
}: QuickPhraseSelectorProps) {
  const lang = useLang();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const categories = Array.from(new Set(phrases.map((p) => p.category)));
  const filtered = activeCategory
    ? phrases.filter((p) => p.category === activeCategory)
    : phrases;

  return (
    <div className="quick-phrase-selector">
      <div className="quick-phrase-header">
        <h3>{S.quickPhrase.title[lang]}</h3>
        <button className="quick-phrase-close" onClick={onClose}>✕</button>
      </div>

      <div className="quick-phrase-categories">
        <button
          className={`category-btn ${activeCategory === null ? "active" : ""}`}
          onClick={() => setActiveCategory(null)}
        >
          {S.quickPhrase.all[lang]}
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            className={`category-btn ${activeCategory === cat ? "active" : ""}`}
            onClick={() => setActiveCategory(cat)}
          >
            {getCategoryLabel(cat, lang)}
          </button>
        ))}
      </div>

      <div className="quick-phrase-list">
        {filtered.map((phrase) => (
          <button
            key={phrase.id}
            className="quick-phrase-item"
            onClick={() => onSelect(phrase.content)}
          >
            <div className="phrase-title">{phrase.title}</div>
            <div className="phrase-content">{phrase.content}</div>
          </button>
        ))}
      </div>
    </div>
  );
});

/** Safe category label lookup */
function getCategoryLabel(cat: string, lang: "zh" | "en"): string {
  const labels: Record<string, { zh: string; en: string }> = {
    coding: S.quickPhrase.coding,
    review: S.quickPhrase.review,
    test: S.quickPhrase.test,
    debug: S.quickPhrase.debug,
    other: S.quickPhrase.other,
  };
  return labels[cat]?.[lang] || cat;
}