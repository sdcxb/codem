/**
 * Stack 市场区块（技能市场页签顶部）。
 *
 * 数据来自 `stacks/index.json`（真实 HTTPS），安装时逐个技能从既有真实技能市场解析；
 * 这里只做展示与触发，不复制下载/校验逻辑。
 *
 * 样式全部复用技能市场已有的类（不新增 CSS）：`skill-manager-toolbar` / `skill-market-grid` /
 * `market-skill-card` 等，避免再养一套皮肤。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchStackIndex,
  installStackFromMarket,
  type StackIndexEntry,
  type StackInstallResult,
} from "../core/skill/stack-market";
import { Badge } from "./ui/badge";
import { IncrementalList } from "./ui/IncrementalList";
import { ActionIcons } from "../core/icons/icon-map";

export function StackMarketSection() {
  const [stacks, setStacks] = useState<StackIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<StackInstallResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await fetchStackIndex();
      setStacks(list);
    } catch (e) {
      setStacks([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (name: string) => {
    setBusy(name);
    setResult(null);
    try {
      setResult(await installStackFromMarket(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="skill-manager-toolbar">
        <div className="skill-search-box">
          <span className="skill-search-icon" aria-hidden="true">包</span>
          <span className="skill-search-input">技能包（stack）</span>
        </div>
        <button className="skill-upload-btn" onClick={() => void load()} disabled={busy !== null}>
          <span>刷新技能包</span>
        </button>
      </div>

      {error && (
        <div className="skill-install-error">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="关闭">
            <ActionIcons.close size={14} />
          </button>
        </div>
      )}

      {stacks === null && (
        <div className="skill-market-loading">
          <span>正在加载技能包市场...</span>
        </div>
      )}

      {stacks !== null && stacks.length === 0 && !error && (
        <div className="skill-market-grid">
          <div className="empty-hint">市场里暂时没有技能包</div>
        </div>
      )}

      {stacks !== null && stacks.length > 0 && (
        <IncrementalList
          className="skill-market-grid"
          items={stacks}
          resetKey="stacks"
          initial={20}
          step={20}
          moreLabel={(rest, next) => `再显示 ${next} 个技能包（还有 ${rest} 个）`}
          renderItem={(stack) => (
            <div key={stack.name} className="market-skill-card">
              <div className="market-skill-card-header">
                <span className="market-skill-icon">包</span>
                <div className="market-skill-card-title">
                  <span className="market-skill-name">{stack.name}</span>
                  <Badge variant="muted">v{stack.version}</Badge>
                </div>
              </div>
              {stack.description && <div className="market-skill-desc">{stack.description}</div>}
              <div className="market-skill-card-footer">
                <div className="market-skill-meta">
                  {stack.skills.map((s) => (
                    <Badge key={s} variant="info">{s}</Badge>
                  ))}
                </div>
                <div className="market-skill-actions">
                  <button
                    className="market-skill-install-btn"
                    disabled={busy !== null}
                    onClick={() => void install(stack.name)}
                  >
                    {busy === stack.name ? "安装中..." : "安装"}
                  </button>
                </div>
              </div>
            </div>
          )}
        />
      )}

      {result && (
        <div className="skill-install-progress">
          <span className="skill-progress-message">
            {result.name}@{result.version}：已安装 {result.installed.length}
            {result.missing.length > 0 ? ` / 缺失 ${result.missing.join(", ")}` : ""}
            {result.failed.length > 0 ? ` / 失败 ${result.failed.map((f) => f.name).join(", ")}` : ""}
          </span>
        </div>
      )}
    </>
  );
}
