/**
 * 「免费模型插件」卡片（第 201 波）。
 *
 * ## 用户的要求与这张卡片的对应关系
 *
 * > 注意这个插件要独立存在，可以开启、暂停、删除，不影响 codem 的使用。集成后，默认开启，
 * > 开启后对话优先从这个插件里获取模型列表服务。
 *
 * - **独立**：它不在 Codem 的插件注册表里（不是 cordis 插件），而是一个**自带数据目录的本地服务**；
 *   这张卡片是它唯一的控制面，卡片上写清"它住在哪儿、跑在哪个端口"。
 * - **开启 / 暂停 / 删除**：三个按钮就是三件事 —— 起进程、停进程（留数据）、停进程 + 清数据目录。
 *   每个动作的结果**如实显示**（起不来就说起不来；没有 Node 就直接说要去装 Node）。
 * - **默认开启**：`freeModelPlugin.readSetting()` 在没有设置时返回 `enabled: true`；
 *   真正的"开机自动启动"在 `App.tsx` 的启动钩子里（这里只负责显示与手动操作）。
 * - **模型列表优先来自插件**：卡片上直接列出它当前供的模型（这是"优先"这件事的可见证据），
 *   并说明拿不到时会自动回退到原有列表。
 *
 * ## 为什么状态要"重新读一遍"而不是只信上一次的返回值
 *
 * 进程可能被外面杀掉（任务管理器 / 崩溃 / 另一个实例占了数据目录）⇒ 每次操作完都重新
 * `status()` 一次，界面上显示的是**当下的真相**，而不是我们以为发生过的事。
 */
import { useCallback, useEffect, useState } from "react";
import { PanelIcons, ActionIcons, StatusIcons } from "../core/icons/icon-map";
import { freeModelPlugin } from "../core/free-model-plugin/service";

type PluginStatus = Awaited<ReturnType<typeof freeModelPlugin.status>>;

export function FreeModelPluginCard() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [busy, setBusy] = useState<"none" | "enable" | "pause" | "remove">("none");
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [logTail, setLogTail] = useState("");
  const [installingNode, setInstallingNode] = useState(false);
  const [nodePhase, setNodePhase] = useState("");

  const refresh = useCallback(async () => {
    const next = await freeModelPlugin.status();
    setStatus(next);
    setModels(next.enabled && next.health ? await freeModelPlugin.models.list() : []);
    /*
     * 只要"启用着但没健康"，就把插件自己的日志尾巴拉出来 —— 这正是真机上唯一能说清
     * "为什么没起来"的东西（缺文件 / 端口被占 / Node 太旧都写在里面）。
     */
    setLogTail(next.enabled && !next.health ? await freeModelPlugin.diagnostics.logTail(12) : "");
  }, []);

  /**
   * 一键装 Node（第 202 波）：装完 `installNode` 内部会把插件启动起来，
   * 所以这里只需刷新状态与清单（**不用**再让用户点一次「开启」）。
   */
  const installNode = useCallback(async () => {
    setInstallingNode(true);
    setNotice("");
    try {
      const result = await freeModelPlugin.installNode((_phase, message) => setNodePhase(message));
      setNotice(result.message);
      if (result.ok) await freeModelPlugin.models.refresh();
    } finally {
      setInstallingNode(false);
      setNodePhase("");
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (kind: "enable" | "pause" | "remove") => {
      setBusy(kind);
      setNotice("");
      try {
        const result =
          kind === "enable"
            ? await freeModelPlugin.enable()
            : kind === "pause"
              ? await freeModelPlugin.pause()
              : await freeModelPlugin.remove();
        setNotice(result.message);
        if (kind === "enable") await freeModelPlugin.models.refresh();
      } finally {
        setBusy("none");
        await refresh();
      }
    },
    [refresh],
  );

  if (!status) {
    return (
      <div className="ofm-card">
        <div className="ofm-card-title">
          <PanelIcons.plugins className="icon-sm" /> {freeModelPlugin.name}
        </div>
        <div className="ofm-card-note">正在读取状态…</div>
      </div>
    );
  }

  /** 一句话状态（界面顶部那一行；每种形态都要能一眼读懂） */
  const stateLabel = !status.codePresent
    ? "内置代码缺失（安装包不完整）"
    : !status.enabled
      ? "已暂停（数据保留）"
      : !status.nodeExe
        ? "已启用，但没找到 Node.js（需要 22+）"
        : status.health
          ? `运行中 · 端口 ${status.port} · ${status.modelCount ?? 0} 个模型`
          : status.running
            ? "进程在跑，但服务没就绪"
            : "已启用，尚未启动";

  const healthy = !!status.health;

  return (
    <div className="ofm-card">
      <div className="ofm-card-head">
        <span className="ofm-card-title">
          <PanelIcons.plugins className="icon-sm" /> {freeModelPlugin.name}
        </span>
        <span className={`ofm-card-state ${healthy ? "is-ok" : status.enabled ? "is-warn" : "is-off"}`}>
          {healthy ? <StatusIcons.success className="icon-xs" /> : <ActionIcons.toggle className="icon-xs" />}
          {stateLabel}
        </span>
      </div>

      <div className="ofm-card-note">
        一个**独立运行**的本地小服务（只监听本机回环地址）：装好即用，不需要登录或填 API Key，
        模型清单跟随上游刷新。Codem 只负责起停它 —— 开启时对话的模型列表**优先**取它的清单，
        取不到时自动回退到原有列表。它发送的请求直达上游公开网关（不是 Codem 的服务器）。
      </div>

      <div className="ofm-card-actions">
        <button className="ofm-btn primary" disabled={busy !== "none" || status.enabled} onClick={() => void act("enable")}>
          {busy === "enable" ? "正在启用…" : "开启"}
        </button>
        <button className="ofm-btn" disabled={busy !== "none" || !status.enabled} onClick={() => void act("pause")}>
          {busy === "pause" ? "正在暂停…" : "暂停"}
        </button>
        <button className="ofm-btn danger" disabled={busy !== "none"} onClick={() => void act("remove")}>
          {busy === "remove" ? "正在删除…" : "删除（清空它的数据）"}
        </button>
        <button className="ofm-btn" disabled={busy !== "none"} onClick={() => void refresh()}>
          刷新状态
        </button>
      </div>

      {notice && <div className="ofm-card-notice">{notice}</div>}
      {status.lastError && <div className="ofm-card-error">最后一条错误：{status.lastError}</div>}

      {/*
        第 202 波（用户实报）：没有 Node 时不要只报"起不来"，直接给一键安装 ——
        用户明确要求「不要让用户自己再去安装」。装完会自动把插件启动起来。
      */}
      {status.enabled && status.codePresent && !status.nodeExe && (
        <div className="ofm-card-actions">
          <button
            className="ofm-btn primary"
            disabled={busy !== "none" || installingNode}
            onClick={() => void installNode()}
          >
            {installingNode ? `正在安装…（${nodePhase || "准备中"}）` : "自动安装 Node（约 30MB）"}
          </button>
        </div>
      )}

      {/* 没起来的时候，把插件自己的输出摆出来 —— 这是"可看运行日志"那句话的兑现 */}
      {logTail && (
        <div className="ofm-card-log">
          <div className="ofm-card-log-title">插件运行日志（最后几行）</div>
          <pre className="ofm-card-log-body">{logTail}</pre>
        </div>
      )}

      <div className="ofm-card-meta">
        <span>Node：{status.nodeExe ? `${status.nodeExe}（${status.nodeVia === "portable" ? "内置便携版" : "系统"}）` : "未找到"}</span>
        <span>数据目录：{status.dataDir ?? "（未知）"}</span>
        {status.pid !== null && <span>进程号：{status.pid}</span>}
      </div>

      {models.length > 0 ? (
        <div className="ofm-card-models">
          <div className="ofm-card-models-title">当前可用的免费模型（{models.length}）</div>
          <div className="ofm-card-models-list">
            {models.slice(0, 12).map((m) => (
              <span key={m.id} className="ofm-model-chip" title={m.name}>
                {m.name}
              </span>
            ))}
            {models.length > 12 && <span className="ofm-model-chip">…还有 {models.length - 12} 个</span>}
          </div>
        </div>
      ) : (
        <div className="ofm-card-note">（模型清单为空：插件没启用、没起来，或上游暂时取不到 —— 都不影响 Codem 原有模型。）</div>
      )}
    </div>
  );
}
