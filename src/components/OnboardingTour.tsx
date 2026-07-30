/**
 * OnboardingTour — 新手引导（driver.js 风格）
 *
 * 使用高亮浮窗引导用户了解界面功能
 */

import { memo, useState, useEffect } from "react";
import { useLang, S } from "../core/i18n/lang";

interface TourStep {
  target: string;
  title: string;
  content: string;
  position?: "top" | "bottom" | "left" | "right";
}

interface OnboardingTourProps {
  /** Tour steps */
  steps: TourStep[];
  /** When tour completes */
  onComplete: () => void;
  /** Skip tour */
  onSkip: () => void;
}

export const OnboardingTour = memo(function OnboardingTour({
  steps,
  onComplete,
  onSkip,
}: OnboardingTourProps) {
  const lang = useLang();
  const [currentStep, setCurrentStep] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [currentStep, steps]);

  const updatePosition = () => {
    const target = document.querySelector(steps[currentStep].target);
    if (target) {
      const rect = target.getBoundingClientRect();
      // Clamp tooltip position to viewport to prevent going off-screen
      let top = rect.top + window.scrollY;
      let left = rect.left + window.scrollX;
      // Estimate tooltip dimensions
      const tooltipWidth = 320;
      const tooltipHeight = 200;
      // Clamp left: keep within viewport
      if (left + tooltipWidth > window.innerWidth) {
        left = Math.max(8, window.innerWidth - tooltipWidth - 16);
      }
      // Clamp top: if tooltip would go below viewport, position above target
      if (top + tooltipHeight > window.innerHeight + window.scrollY) {
        top = Math.max(8 + window.scrollY, rect.top + window.scrollY - tooltipHeight - 8);
      }
      setPosition({ top, left });
    }
  };

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const step = steps[currentStep];

  return (
    <div className="onboarding-tour">
      {/* Highlight overlay */}
      <div className="tour-overlay" />

      {/* Tooltip */}
      <div
        className="tour-tooltip"
        style={{ top: position.top, left: position.left }}
      >
        <div className="tour-header">
          <h4>{step.title}</h4>
          <button className="tour-skip" onClick={onSkip}>
            {S.onboarding.skip[lang]}
          </button>
        </div>
        <div className="tour-content">{step.content}</div>
        <div className="tour-footer">
          <span className="tour-progress">
            {currentStep + 1} / {steps.length}
          </span>
          <div className="tour-nav">
            {currentStep > 0 && (
              <button className="tour-btn prev" onClick={handlePrevious}>
                {S.onboarding.previous[lang]}
              </button>
            )}
            <button className="tour-btn next" onClick={handleNext}>
              {currentStep === steps.length - 1
                ? S.onboarding.finish[lang]
                : S.onboarding.next[lang]}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});