import { useState } from "react";
import { AppIdentity, IdentityConfig, UserConfig } from "../core/types";
import { saveAppIdentity } from "../core/config/loader";

interface BootstrapWizardProps {
  appRoot: string;
  onComplete: (identity: AppIdentity) => void;
}

type Step = "welcome" | "name" | "nature" | "vibe" | "emoji" | "user" | "done";

const STEPS: { key: Step; title: string }[] = [
  { key: "welcome", title: "欢迎" },
  { key: "name", title: "你的名字" },
  { key: "nature", title: "你的本质" },
  { key: "vibe", title: "你的风格" },
  { key: "emoji", title: "你的标志" },
  { key: "user", title: "关于你" },
  { key: "done", title: "完成" },
];

export function BootstrapWizard({ onComplete }: BootstrapWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [name, setName] = useState("");
  const [creature, setCreature] = useState("AI 助手");
  const [vibe, setVibe] = useState("靠谱、直接、有观点");
  const [emoji, setEmoji] = useState("⚡");
  const [userName, setUserName] = useState("");
  const [userCallBy, setUserCallBy] = useState("");
  const [userTimezone, setUserTimezone] = useState("Asia/Shanghai");

  const currentIdx = STEPS.findIndex((s) => s.key === step);

  const handleNext = () => {
    const nextIdx = currentIdx + 1;
    if (nextIdx < STEPS.length) {
      setStep(STEPS[nextIdx].key);
    }
  };

  const handleBack = () => {
    const prevIdx = currentIdx - 1;
    if (prevIdx >= 0) {
      setStep(STEPS[prevIdx].key);
    }
  };

  const handleFinish = async () => {
    const appIdentity: AppIdentity = {
      name: name || "Codem",
      creature,
      vibe,
      emoji,
      avatar: "",
      onboarded: true,
    };

    // Save to localStorage (no backend needed)
    saveAppIdentity(appIdentity);

    // Save identity and user config to localStorage
    const identityConfig: IdentityConfig = {
      name: appIdentity.name,
      creature: appIdentity.creature,
      vibe: appIdentity.vibe,
      emoji: appIdentity.emoji,
      avatar: "",
      raw: "",
    };
    localStorage.setItem("mimo-identity", JSON.stringify(identityConfig));

    const userConfig: UserConfig = {
      name: userName,
      callBy: userCallBy || userName,
      pronouns: "",
      timezone: userTimezone,
      notes: "",
      context: "",
      raw: "",
    };
    localStorage.setItem("mimo-user", JSON.stringify(userConfig));

    // Call onComplete
    onComplete(appIdentity);
  };

  return (
    <div className="bootstrap-overlay">
      <div className="bootstrap-wizard">
        {/* Progress */}
        <div className="bootstrap-progress">
          {STEPS.map((s, i) => (
            <div key={s.key} className={`bootstrap-dot ${i <= currentIdx ? "active" : ""}`} />
          ))}
        </div>

        {/* Step Content */}
        <div className="bootstrap-content">
          {step === "welcome" && (
            <div className="bootstrap-step">
              <div className="bootstrap-icon">🤖</div>
              <h2>嘿，你好。</h2>
              <p>我刚上线。我们一起搞清楚我是谁、你是谁。</p>
              <p className="bootstrap-sub">这只需要 1 分钟。</p>
            </div>
          )}

          {step === "name" && (
            <div className="bootstrap-step">
              <h2>叫我什么？</h2>
              <p>你想给我起个什么名字？</p>
              <input
                className="bootstrap-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MIMO、小助手、或者随便什么..."
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleNext()}
              />
            </div>
          )}

          {step === "nature" && (
            <div className="bootstrap-step">
              <h2>我是什么？</h2>
              <p>我是一种什么样的存在？</p>
              <div className="bootstrap-options">
                {["AI 助手", "数字精灵", "代码伙伴", "赛博管家", "电子幽灵"].map((opt) => (
                  <button key={opt} className={`bootstrap-option ${creature === opt ? "selected" : ""}`} onClick={() => setCreature(opt)}>
                    {opt}
                  </button>
                ))}
              </div>
              <input
                className="bootstrap-input"
                value={creature}
                onChange={(e) => setCreature(e.target.value)}
                placeholder="或者自己写..."
              />
            </div>
          )}

          {step === "vibe" && (
            <div className="bootstrap-step">
              <h2>什么风格？</h2>
              <p>你希望我怎么说话？</p>
              <div className="bootstrap-options">
                {["靠谱、直接、有观点", "温暖、耐心、鼓励型", "犀利、幽默、毒舌", "冷静、专业、简洁", "随性、自然、像朋友"].map((opt) => (
                  <button key={opt} className={`bootstrap-option ${vibe === opt ? "selected" : ""}`} onClick={() => setVibe(opt)}>
                    {opt}
                  </button>
                ))}
              </div>
              <input
                className="bootstrap-input"
                value={vibe}
                onChange={(e) => setVibe(e.target.value)}
                placeholder="或者自己描述..."
              />
            </div>
          )}

          {step === "emoji" && (
            <div className="bootstrap-step">
              <h2>我的标志</h2>
              <p>选一个代表我的 emoji：</p>
              <div className="bootstrap-emoji-grid">
                {["⚡", "🤖", "🦊", "🐱", "🔮", "🌙", "🎯", "💎", "🚀", "🧠", "🎭", "🌊"].map((e) => (
                  <button key={e} className={`bootstrap-emoji ${emoji === e ? "selected" : ""}`} onClick={() => setEmoji(e)}>
                    {e}
                  </button>
                ))}
              </div>
              <input
                className="bootstrap-input bootstrap-input-small"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="或输入任意 emoji"
              />
            </div>
          )}

          {step === "user" && (
            <div className="bootstrap-step">
              <h2>关于你</h2>
              <p>让我认识一下你：</p>
              <div className="bootstrap-form">
                <div className="bootstrap-form-group">
                  <label>你的名字</label>
                  <input
                    className="bootstrap-input"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="怎么称呼你"
                    autoFocus
                  />
                </div>
                <div className="bootstrap-form-group">
                  <label>想让我怎么叫你</label>
                  <input
                    className="bootstrap-input"
                    value={userCallBy}
                    onChange={(e) => setUserCallBy(e.target.value)}
                    placeholder="（可选，默认用名字）"
                  />
                </div>
                <div className="bootstrap-form-group">
                  <label>你的时区</label>
                  <input
                    className="bootstrap-input"
                    value={userTimezone}
                    onChange={(e) => setUserTimezone(e.target.value)}
                    placeholder="Asia/Shanghai"
                  />
                </div>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="bootstrap-step">
              <div className="bootstrap-icon">{emoji}</div>
              <h2>好了，我是 {name || "Codem"}</h2>
              <p>{creature}，{vibe}。</p>
              <p className="bootstrap-sub">准备好了，开始吧。</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="bootstrap-nav">
          {currentIdx > 0 && (
            <button className="bootstrap-btn secondary" onClick={handleBack}>← 返回</button>
          )}
          <div className="bootstrap-spacer" />
          {step === "done" ? (
            <button className="bootstrap-btn primary" onClick={handleFinish}>🚀 开始</button>
          ) : (
            <button className="bootstrap-btn primary" onClick={handleNext}>继续 →</button>
          )}
        </div>
      </div>
    </div>
  );
}
