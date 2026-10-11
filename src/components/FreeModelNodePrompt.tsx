/**
 * 「免费模型插件需要 Node.js」的**选择框**（第 202 波）。
 *
 * ## 为什么要有它（用户实报）
 *
 * 用户装完 1.16.309 后收到的是这样一条通知：
 *
 * > 免费模型插件没有启动起来：没有找到可用的 Node.js（需要 22 或更高）⇒ 插件无法启动。
 * > 装一个 Node 之后重试即可。到「插件管理 → 插件市场」那张卡片上点「刷新状态」看真实原因；
 * > 装一个 Node.js 22+ 之后重试即可。
 *
 * 这条通知**只说问题、把活儿留给用户**（自己去官网下载安装）。用户的原话：
 * 「如果是这个通知里，加一个是否安装的选择，用户选择是，自动安装。不要让用户自己再去安装。」
 *
 * 所以这里就放在通知该出现的地方 —— 应用启动后如果插件启用着却没有 Node，直接给两个按钮：
 * 「现在安装」/「以后再说」。装的是**便携版 Node**（走与 zvec-grep 共用的那份实现，
 * 约 30MB，装进插件自己的扩展目录），装完**顺手把插件启动起来**并刷新模型清单。
 *
 * ## 两条纪律
 *
 * - **不重复打扰**：选「以后再说」会写进设置（`nodePromptDismissedAt`），之后不再弹；
 *   想装随时可以到插件卡片的「自动安装 Node」再点。
 * - **失败如实说**：下载失败就把原因显示出来（含"可以稍后重试/自行安装"的出路），不假装装好了。
 */
import { useCallback, useEffect, useState } from "react";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import { freeModelPlugin } from "../core/free-model-plugin/service";

type PluginStatus = Awaited<ReturnType<typeof freeModelPlugin.status>>;

export function FreeModelNodePrompt() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [phase, setPhase] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await freeModelPlugin.status());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 只在这个形态下弹：用户启用着它、代码在、**没有 Node**、而且没说过"以后再说" */
  const shouldPrompt =
    !!status &&
    status.enabled &&
    status.codePresent &&
    !status.nodeExe &&
    !freeModelPlugin.readSetting().nodePromptDismissedAt;

  if (!shouldPrompt) return null;

  const install = async () => {
    setInstalling(true);
    setNotice("");
    try {
      const result = await freeModelPlugin.installNode((p, message) => setPhase(`${p}：${message}`));
      setNotice(result.message);
      if (result.ok) await freeModelPlugin.models.refresh();
    } finally {
      setInstalling(false);
      setPhase("");
      await refresh();
    }
  };

  return (
    <div className="ofm-node-prompt" role="dialog" aria-label="免费模型插件需要 Node.js">
      <div className="ofm-node-prompt-head">
        <PanelIcons.plugins className="icon-sm" />
        <span className="ofm-node-prompt-title">免费模型插件需要 Node.js</span>
      </div>
      <div className="ofm-node-prompt-body">
        内置的免费模型插件是一个 Node 小程序（需要 22 或更高）。这台机器上没找到 Node，
        所以它现在没启动 —— **不影响 Codem 自己的模型与聊天**。
        可以让 Codem 现在自动装一个便携版（约 30MB，装在插件自己的目录里，删除插件时会一起清掉）。
      </div>
      {phase && <div className="ofm-node-prompt-phase">{phase}</div>}
      {notice && <div className="ofm-node-prompt-notice">{notice}</div>}
      <div className="ofm-node-prompt-actions">
        <button className="ofm-btn primary" disabled={installing} onClick={() => void install()}>
          {installing ? "正在安装…" : "现在安装"}
        </button>
        <button
          className="ofm-btn"
          disabled={installing}
          onClick={() => {
            freeModelPlugin.dismissNodePrompt();
            setStatus(null); /* 关掉自己：不再打扰 */
          }}
        >
          以后再说（不再提醒）
        </button>
        <button className="ofm-btn" disabled={installing} onClick={() => void refresh()}>
          <ActionIcons.toggle className="icon-xs" /> 刷新状态
        </button>
      </div>
    </div>
  );
}
