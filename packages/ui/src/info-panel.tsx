/**
 * 只读“连接信息”面板（Phase 3 的第一块：让手机能看到自己连的是哪台 Host、能做什么）。
 *
 * 只读：hostId、协议能力、事件水位、当前运行数、工作区路径。
 * 唯一的写入口是**本机模型设置**（只有 Android 原生桥存在时出现）：按钮只打开原生对话框，
 * Key 不经过这个页面（见 `native-bridge.ts` 的边界说明）。
 */
import { useEffect, useState } from "react";

import type { SessionTransport, TransportAuthInfo } from "./transport";
import {
  getNativeBridge,
  keyStateLabel,
  readLlmSettingsSummary,
  type CodemNativeBridge,
  type LlmSettingsSummary,
} from "./native-bridge";

interface Info {
  hostId: string;
  supported: string[];
  unsupported: string[];
  seq?: number;
  runs?: number;
  workspaceRoot?: string;
  /** Host 的工作区是否就是桌面当前项目（只有桌面 Host 会报 true） */
  workspaceSharedWithDesktop?: boolean;
  auth?: TransportAuthInfo;
}

/**
 * 认证身份只显示"是什么"，不显示任何凭据值。
 *
 * `local` 曾经写作"本机（免鉴权）"。`local-auth` 模式下本机也要带凭据，
 * 那句文案会变成假话 ⇒ 统一只说"本机"，把"要不要凭据"留给 Host 的行为表达。
 */
function authLabel(auth: TransportAuthInfo): string {
  if (auth.kind === "local") return "本机";
  if (auth.kind === "static") return "固定访问令牌";
  return `已配对：${auth.deviceName || auth.deviceId || "未知设备"}`;
}

export function InfoPanel(props: {
  transport: SessionTransport;
  onClose: () => void;
  /**
   * 原生桥（只有 Android 注入）。默认自动探测；显式 `null` 表示"确定没有"
   * （判据用它钉住"桌面不出现设置入口"）。
   */
  bridge?: CodemNativeBridge | null;
}): React.ReactElement {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string; version: string }>>([]);
  const bridge = props.bridge === undefined ? getNativeBridge() : props.bridge;
  const [llm, setLlm] = useState<LlmSettingsSummary | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!props.transport.hostInfo) throw new Error("当前连接不提供连接信息");
        const got = await props.transport.hostInfo();
        if (alive) setInfo(got);
        const list = await props.transport.listPlugins?.().catch(() => null);
        if (alive && list?.items) setPlugins(list.items);
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.transport]);

  /**
   * 摘要只在 Android 上读；原生对话框关闭后窗口重新获得焦点（或页面重新可见）时再读一次，
   * 这样"保存完回到面板"看到的是新值。读不到就显示"读取不到"，不编造。
   */
  useEffect(() => {
    if (!bridge) {
      setLlm(null);
      return;
    }
    const read = (): void => setLlm(readLlmSettingsSummary(bridge));
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [bridge]);

  /** 只传"打开"这一件事；失败不抛给页面（按钮点不动比白屏好） */
  function openSettings(): void {
    try {
      bridge?.openLlmSettings();
    } catch {
      /* 原生侧不可用时保持面板原状 */
    }
  }

  return (
    <div className="info-panel" role="dialog" aria-label="connection info">
      <div className="file-browser-head">
        <span className="file-browser-path">连接信息（只读）</span>
        <button onClick={props.onClose}>关闭</button>
      </div>
      {error ? <div className="file-browser-error">{error}</div> : null}
      {/*
        本机模型设置：**只有 Android 原生桥存在时**才渲染（桌面渲染进程没有这个对象）。
        放在 `info` 之外：即使 `hostInfo` 读失败（Host 半死），这里仍然要能改配置 ——
        "连不上 Host"正是最需要改模型设置的时候。
      */}
      {bridge ? (
        <div className="info-body" data-testid="native-llm-settings">
          <div className="info-section-title">本机模型设置（仅 Android）</div>
          {llm ? (
            <>
              <div className="info-row">
                <span>服务地址</span>
                <code>{llm.baseUrl || "未设置"}</code>
              </div>
              <div className="info-row">
                <span>模型</span>
                <code>{llm.model || "未设置"}</code>
              </div>
              <div className="info-row">
                <span>API Key</span>
                <code>{keyStateLabel(llm)}</code>
              </div>
              {llm.insecureHttp ? (
                <div className="info-row" data-testid="native-llm-insecure">
                  <span>安全提示</span>
                  <code>当前是 http 明文端点</code>
                </div>
              ) : null}
            </>
          ) : (
            <div className="file-browser-empty">读取不到本机配置</div>
          )}
          <button
            className="files-button"
            data-testid="open-native-llm-settings"
            onClick={openSettings}
          >
            设置
          </button>
        </div>
      ) : null}
      {!info && !error ? <div className="file-browser-empty">读取中…</div> : null}
      {info ? (
        <div className="info-body">
          <div className="info-row">
            <span>Host</span>
            <code>{info.hostId}</code>
          </div>
          {info.auth ? (
            <div className="info-row">
              <span>认证</span>
              <code>{authLabel(info.auth)}</code>
            </div>
          ) : null}
          {typeof info.seq === "number" ? (
            <div className="info-row">
              <span>事件水位</span>
              <code>seq {info.seq}</code>
            </div>
          ) : null}
          {typeof info.runs === "number" ? (
            <div className="info-row">
              <span>运行中</span>
              <code>{info.runs}</code>
            </div>
          ) : null}
          {info.workspaceRoot ? (
            <div className="info-row">
              <span>工作区</span>
              <code>
                {info.workspaceRoot}
                {info.workspaceSharedWithDesktop === true ? "（与桌面同一份）" : ""}
              </code>
            </div>
          ) : null}
          {/*
            只有 Host **明确上报**这是桌面项目工作区时才说"同一份"。
            Android 本机 Host 的 /opt/app/web 与任何桌面目录都没有关系：在这里默认声称
            同一份就是假话（所以缺省一律不显示）。
          */}
          {info.workspaceSharedWithDesktop === true ? (
            <div className="info-row" data-testid="info-shared-note">
              <span>说明</span>
              <code>文件与桌面同一份；会话是 Host 自己的会话，不是桌面历史。</code>
            </div>
          ) : null}
          <div className="info-section-title">可用能力（{info.supported.length}）</div>
          <div className="info-chips">
            {info.supported.map((m) => (
              <span className="info-chip" key={m}>
                {m}
              </span>
            ))}
          </div>
          {info.unsupported.length > 0 ? (
            <>
              <div className="info-section-title">未支持（{info.unsupported.length}）</div>
              <div className="info-chips">
                {info.unsupported.map((m) => (
                  <span className="info-chip info-chip--off" key={m}>
                    {m}
                  </span>
                ))}
              </div>
            </>
          ) : null}
          <div className="info-section-title">已安装插件（{plugins.length}）</div>
          {plugins.length === 0 ? <div className="file-browser-empty">（Host 未安装插件）</div> : null}
          {plugins.map((p) => (
            <div className="info-row" key={p.id}>
              <span>{p.name}</span>
              <code>{p.version || p.id}</code>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
