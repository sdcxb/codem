import { useState, useEffect } from "react";
import { useLang } from "../core/i18n/lang";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import type { GitConfig, EnvironmentConfig, CustomOperation } from "../core/settings/settings";
import { runCustomOperation } from "../core/environment";
import { isAutoCommitEnabled, setAutoCommitEnabled } from "../core/environment/git-commit-service";

/**
 * Git 偏好 / 环境脚本 两段设置。
 *
 * 样式：第 17 波把内联样式收口成 `.git-env-*` 具名类（见 src/styles.css），
 * 保存按钮复用共享 `.panel-btn .panel-btn--primary`。
 */

// ========== G Series: Git Configuration Section ==========

export function GitConfigSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [gitConfig, setGitConfig] = useState<GitConfig>({});
  const [saved, setSaved] = useState(false);
  const [autoCommit, setAutoCommit] = useState(false);

  useEffect(() => {
    const stored = getSettingJSON<GitConfig | null>("codem-git-config", null);
    if (stored) setGitConfig(stored);
    setAutoCommit(isAutoCommitEnabled());
  }, []);

  const handleSave = () => {
    setSettingJSON("codem-git-config", gitConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (upd: Partial<GitConfig>) => setGitConfig(prev => ({ ...prev, ...upd }));

  return (
    <div className="setting-group">
      <div className="settings-section-title">{zh ? "🌿 Git 偏好配置" : "🌿 Git Preferences"}</div>
      <div className="git-env-desc">
        {zh ? "配置 Git 操作偏好。AI 执行 Git 命令时会遵循这些规则。" : "Configure Git preferences. The AI follows these rules for Git operations."}
      </div>

      {/* Branch prefix */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "分支前缀" : "Branch Prefix"}
        </label>
        <input
          type="text"
          value={gitConfig.branchPrefix || ""}
          onChange={(e) => update({ branchPrefix: e.target.value })}
          placeholder={zh ? "如 feature/ 或 feat/" : "e.g. feature/ or feat/"}
          className="git-env-input is-mono"
        />
        <div className="git-env-hint">
          {zh ? "创建新分支时自动添加此前缀" : "Prepended to new branch names"}
        </div>
      </div>

      {/* Merge method */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "PR 合并方法" : "PR Merge Method"}
        </label>
        <select
          value={gitConfig.mergeMethod || ""}
          onChange={(e) => update({ mergeMethod: (e.target.value || undefined) as GitConfig["mergeMethod"] })}
          className="git-env-input"
        >
          <option value="">{zh ? "默认（不指定）" : "Default"}</option>
          <option value="merge">Merge commit</option>
          <option value="squash">Squash and merge</option>
          <option value="rebase">Rebase and merge</option>
        </select>
      </div>

      {/* Force push */}
      <div className="git-env-field git-env-field--inline">
        <input
          type="checkbox"
          id="git-force-push"
          checked={gitConfig.forcePush === true}
          onChange={(e) => update({ forcePush: e.target.checked })}
          className="git-env-checkbox"
        />
        <label htmlFor="git-force-push" className="git-env-check-label">
          {zh ? "允许强制推送 (force push)" : "Allow force push"}
        </label>
      </div>

      {/* Draft PR */}
      <div className="git-env-field git-env-field--inline">
        <input
          type="checkbox"
          id="git-draft-pr"
          checked={gitConfig.draftPR === true}
          onChange={(e) => update({ draftPR: e.target.checked })}
          className="git-env-checkbox"
        />
        <label htmlFor="git-draft-pr" className="git-env-check-label">
          {zh ? "默认创建草稿 PR" : "Default to draft PR"}
        </label>
      </div>

      {/* Auto Commit */}
      <div className="git-env-toggle-card">
        <div className="git-env-toggle-row">
          <div>
            <label className="git-env-toggle-label" htmlFor="git-auto-commit">
              {zh ? "🔄 自动 Commit" : "🔄 Auto Commit"}
            </label>
            <div className="git-env-hint">
              {zh ? "Agent 每轮修改后自动 git add + commit（可通过 LLM 生成提交信息）" : "Auto git add + commit after each agent turn (LLM-generated message)"}
            </div>
          </div>
          <input
            type="checkbox"
            id="git-auto-commit"
            checked={autoCommit}
            onChange={(e) => { setAutoCommit(e.target.checked); setAutoCommitEnabled(e.target.checked); }}
            className="git-env-checkbox"
          />
        </div>
      </div>

      {/* GitHub Token */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "GitHub Token（用于 API 操作）" : "GitHub Token (for API operations)"}
        </label>
        <input
          type="password"
          value={gitConfig.githubToken || ""}
          onChange={(e) => update({ githubToken: e.target.value })}
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
          className="git-env-input is-mono"
        />
        <div className="git-env-hint">
          {zh ? "用于创建远程仓库、技能市场 API 认证等操作。需要 repo 权限。配置后可将 GitHub API 限流从 60 次/小时提升至 5000 次/小时。" : "Used for creating repositories, skill market API auth, etc. Requires repo scope. Raises API rate limit from 60 to 5000 req/hour."}
        </div>
      </div>

      {/* Commit message instructions */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "提交信息风格指令" : "Commit Message Instructions"}
        </label>
        <textarea
          value={gitConfig.commitMessageInstructions || ""}
          onChange={(e) => update({ commitMessageInstructions: e.target.value })}
          placeholder={zh ? "如：conventional commits 格式" : "e.g. conventional commits"}
          rows={2}
          className="git-env-input"
        />
      </div>

      {/* PR title instructions */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "PR 标题风格指令" : "PR Title Instructions"}
        </label>
        <input
          type="text"
          value={gitConfig.prTitleInstructions || ""}
          onChange={(e) => update({ prTitleInstructions: e.target.value })}
          placeholder={zh ? "如：[模块] 简短描述" : "e.g. [Module] Brief"}
          className="git-env-input"
        />
      </div>

      {/* PR description instructions */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "PR 描述风格指令" : "PR Description Instructions"}
        </label>
        <textarea
          value={gitConfig.prDescriptionInstructions || ""}
          onChange={(e) => update({ prDescriptionInstructions: e.target.value })}
          placeholder={zh ? "如：包含改动原因、测试方案" : "e.g. Include rationale and tests"}
          rows={2}
          className="git-env-input"
        />
      </div>

      <button
        onClick={handleSave}
        className="panel-btn panel-btn--primary git-env-save-btn"
      >
        {saved ? (zh ? "✅ 已保存" : "✅ Saved") : (zh ? "保存 Git 配置" : "Save Git Config")}
      </button>
    </div>
  );
}

// ========== ENV Series: Environment Scripts Section ==========

export function EnvironmentConfigSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [envConfig, setEnvConfig] = useState<EnvironmentConfig>({});
  const [saved, setSaved] = useState(false);
  const [runResult, setRunResult] = useState("");
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    const stored = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null);
    if (stored) setEnvConfig(stored);
  }, []);

  const handleSave = () => {
    setSettingJSON("codem-env-config", envConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (upd: Partial<EnvironmentConfig>) => setEnvConfig(prev => ({ ...prev, ...upd }));

  const addCustomOperation = () => {
    const newOp: CustomOperation = {
      id: `op-${Date.now()}`,
      name: zh ? "新操作" : "New Operation",
      command: "",
      icon: "🔧",
    };
    update({ customOperations: [...(envConfig.customOperations || []), newOp] });
  };

  const updateOp = (id: string, upd: Partial<CustomOperation>) => {
    update({
      customOperations: (envConfig.customOperations || []).map(op =>
        op.id === id ? { ...op, ...upd } : op
      ),
    });
  };

  const removeOp = (id: string) => {
    update({
      customOperations: (envConfig.customOperations || []).filter(op => op.id !== id),
    });
  };

  const handleRun = async (opId: string) => {
    const op = (envConfig.customOperations || []).find(o => o.id === opId);
    if (!op || !op.command.trim()) return;
    setRunning(opId);
    setRunResult("");
    try {
      const { useProjectStore } = await import("../core/store");
      const cwd = useProjectStore.getState().currentProject?.path;
      if (!cwd) {
        setRunResult(zh ? "❌ 未打开项目" : "❌ No project open");
        return;
      }
      const result = await runCustomOperation(opId, cwd);
      if (result) {
        const lines: string[] = [
          `${zh ? "操作" : "Operation"}: ${op.name}`,
          `${zh ? "命令" : "Command"}: ${op.command}`,
          `${zh ? "耗时" : "Duration"}: ${result.duration}ms`,
          `${zh ? "退出码" : "Exit"}: ${result.exitCode}`,
        ];
        if (result.stdout) lines.push(`\nstdout:\n${result.stdout}`);
        if (result.stderr) lines.push(`\nstderr:\n${result.stderr}`);
        lines.push(result.success ? "✅ " + (zh ? "成功" : "Success") : "❌ " + (zh ? "失败" : "Failed"));
        setRunResult(lines.join("\n"));
      }
    } catch (e: any) {
      setRunResult(`❌ ${e?.message || e}`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="setting-group">
      <div className="settings-section-title">{zh ? "🏗️ 环境脚本配置" : "🏗️ Environment Scripts"}</div>
      <div className="git-env-desc">
        {zh
          ? "配置项目环境脚本。打开/切换项目时自动执行设置和清理脚本，还可以定义一键操作。"
          : "Setup/cleanup scripts run automatically on project switch. Custom operations are one-click actions."}
      </div>

      {/* Setup script */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "设置脚本（打开项目时自动执行）" : "Setup Script (on project open)"}
        </label>
        <input
          type="text"
          value={envConfig.setupScript || ""}
          onChange={(e) => update({ setupScript: e.target.value })}
          placeholder={zh ? "如 npm install" : "e.g. npm install"}
          className="git-env-input is-mono"
        />
      </div>

      {/* Cleanup script */}
      <div className="git-env-field">
        <label className="git-env-label">
          {zh ? "清理脚本（切换/关闭项目时执行）" : "Cleanup Script (on project close)"}
        </label>
        <input
          type="text"
          value={envConfig.cleanupScript || ""}
          onChange={(e) => update({ cleanupScript: e.target.value })}
          placeholder={zh ? "如 docker compose down" : "e.g. docker compose down"}
          className="git-env-input is-mono"
        />
      </div>

      {/* Custom operations */}
      <div className="git-env-field">
        <div className="git-env-ops-head">
          <label className="git-env-label" style={{ marginBottom: 0 }}>
            {zh ? "自定义操作" : "Custom Operations"}
          </label>
          <button
            onClick={addCustomOperation}
            className="panel-btn panel-btn--xs"
          >
            + {zh ? "添加" : "Add"}
          </button>
        </div>

        {(envConfig.customOperations || []).length === 0 && (
          <div className="git-env-ops-empty">
            {zh ? "暂无自定义操作。点击\"添加\"创建一键构建/启动/测试等操作。" : "No custom operations yet."}
          </div>
        )}

        {(envConfig.customOperations || []).map((op) => (
          <div key={op.id} className="git-env-op">
            <input
              type="text"
              value={op.icon || ""}
              onChange={(e) => updateOp(op.id, { icon: e.target.value })}
              placeholder="🔧"
              className="git-env-op-icon"
            />
            <div className="git-env-op-main">
              <input
                type="text"
                value={op.name}
                onChange={(e) => updateOp(op.id, { name: e.target.value })}
                placeholder={zh ? "操作名称" : "Name"}
                className="git-env-op-name"
              />
              <input
                type="text"
                value={op.command}
                onChange={(e) => updateOp(op.id, { command: e.target.value })}
                placeholder={zh ? "如 npm run build" : "e.g. npm run build"}
                className="git-env-op-cmd"
              />
            </div>
            <button
              onClick={() => handleRun(op.id)}
              disabled={running === op.id || !op.command.trim()}
              className="git-env-run-btn"
            >
              {running === op.id ? "⏳" : "▶"}
            </button>
            <button
              onClick={() => removeOp(op.id)}
              className="git-env-remove-btn"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {runResult && (
        <pre className="git-env-result">
          {runResult}
        </pre>
      )}

      <button
        onClick={handleSave}
        className="panel-btn panel-btn--primary git-env-save-btn"
      >
        {saved ? (zh ? "✅ 已保存" : "✅ Saved") : (zh ? "保存环境配置" : "Save Environment Config")}
      </button>
    </div>
  );
}
