/**
 * 移动端应用（阶段 2）：外壳只负责"列表/标题/布局"，会话交互全部交给 `useSessionChat`。
 *
 * 与旧壳的差别只在"由谁渲染"：DOM 结构与 class 名保持不变（`header/main/footer/.msg/.tool`），
 * 所以样式、判据、截图口径全部沿用；数据流换成 `SessionTransport`（远程实现是 `remoteTransport`）。
 * 桌面只要注入 `localTransport`，同一套 hook/组件就能跑。
 */
import * as React from "react";
import { useEffect, useRef, useState } from "react";

import { ApprovalCard, toApprovalDecision } from "./approval-card";
import { Banner, Composer, ContinueBar, Header, MessageList, SessionList, type SessionSummaryView } from "./components";
import { HostRpcError, createHostClient } from "./host-client";
import { FileBrowser, WorkspaceDiffPane } from "./file-browser";
import { SessionChangesPane } from "./changes-pane";
import { InfoPanel } from "./info-panel";
import { PairingGate } from "./pairing-gate";
import { SplitLayout } from "./shell";
import { WorkspaceDetail, type DetailTab } from "./detail-pane";
import { clearHostToken, resolveHostToken } from "./transport";
import {
  capabilitiesFor,
  capabilitiesFromMethods,
  canWriteSessions,
  remoteTransport,
  type Capabilities,
  type SessionTransport,
} from "./transport";
import { useSessionChat } from "./use-session-chat";

export interface MobileAppProps {
  baseUrl?: string;
  /**
   * 本机凭据的引导结果（只有 Android 本机页面会有）。
   *
   * - `{ token }`：RPC 带 Bearer；失败时显示"本机凭据失效"，**不进配对门**
   *   （`local-auth` 模式下 Host 不接受匿名的 `pair.claim`，配对门只会一直失败）；
   * - `{ problem: "missing" }`：页面没带 fragment 也没存过凭据（例如手工打开、WebView 恢复）；
   * - `{ problem: "rejected" }`：凭据被 Host 拒绝（通常是 Host 重启后旧值）。
   *
   * 远程（连接电脑）模式完全没有这个字段：行为保持原样。
   */
  localAuth?: LocalAuthState;
}

/**
 * 写模式（发送/停止/审批）由 `host.hello.capabilities.supported` 决定，
 * **不是**由"哪个宿主在发页面"。
 *
 * M1 时代网关注入 `window.__CODEM_GATEWAY_READ_ONLY__` 强制只读；M2 之后
 * 网关与 Host 各自如实报能力表，同一份 `ui.js` 不再需要任何宿主标记
 * （标记已删除，见 `src-tauri/src/phone/gateway/assets.rs` 文件头）。
 */

/** 本机凭据的三种状态：带着用 / 缺失 / 被拒 */
export type LocalAuthState = { token: string; problem?: undefined } | { token?: undefined; problem: "missing" | "rejected" };

/**
 * 本机凭据不可用时的错误页。
 *
 * 为什么不能复用 `PairingGate`：`local-auth` 模式下匿名 `pair.claim` 已经被关掉，
 * 配对门只会把"重新打开应用"这条唯一可行的动作藏起来。
 */
function LocalAuthError(props: { problem: "missing" | "rejected" }): React.ReactElement {
  const title = props.problem === "missing" ? "本机凭据缺失" : "本机凭据已失效";
  return (
    <div
      className="pairing-gate"
      data-testid="local-auth-error"
      role="alert"
      style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }}
    >
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
        本机页面必须由 Codem 应用打开（每次启动都会重新注入凭据）。请回到桌面重新打开应用。
      </div>
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        重新加载
      </button>
    </div>
  );
}

function MobileSession(props: {
  transport: SessionTransport;
  sessionId: string;
  caps: Capabilities;
  autoSendText?: string;
  onRunState: (state: string | null) => void;
  onTitle: (title: string) => void;
  readOnly: boolean;
}): React.ReactElement {
  const chat = useSessionChat({
    transport: props.transport,
    sessionId: props.sessionId,
    caps: props.caps,
    readOnly: props.readOnly,
    autoSendText: props.autoSendText,
    onRunState: props.onRunState,
  });
  /** 正在等 Host 回执的那条审批：按钮禁用，避免连点两次发出两个答复 */
  const [answering, setAnswering] = useState<string | null>(null);

  useEffect(() => {
    void props.transport
      .getSession(props.sessionId)
      .then((got) => props.onTitle(got.title || "Codem Remote"))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.transport, props.sessionId]);

  return (
    <>
      <main>
        {chat.error ? <Banner text={chat.error} error /> : null}
        <MessageList views={chat.views} streaming={chat.streaming} />
      </main>
      {chat.canContinue && chat.approvals.length === 0 && !props.readOnly ? (
        <ContinueBar onContinue={() => void chat.continueRun()} disabled={chat.runState === "running"} />
      ) : null}
      {props.caps.approvals
        ? chat.approvals.map((approval) => {
            const request = toApprovalDecision(approval);
            return (
              <ApprovalCard
                key={request.id}
                request={request}
                busy={answering === request.id}
                /* 手机没有「记住这次决策」的通道（approval-broker 刻意只做一次性授权），
                   也没有 note 通道 —— 两个能力位都如实置 false：按钮不出现，而不是画出来没反应。 */
                capabilities={{ alwaysAllow: false, rejectReason: false }}
                onResolve={(_id, outcome) => {
                  setAnswering(request.id);
                  void chat
                    .respondApproval(request.id, outcome.kind === "allow" ? "allow" : "deny")
                    .finally(() => setAnswering(null));
                }}
              />
            );
          })
        : null}
      {props.readOnly ? (
        <div className="pick-session" data-testid="gateway-read-only">
          只读模式：当前连接未开放「发送 + 停止 + 审批」全部能力，发送/审批/取消暂不可用。
        </div>
      ) : (
        <Composer
          value={chat.input}
          disabled={false}
          canSend={chat.canSend}
          canCancel={chat.canCancel}
          canGuide={chat.canGuide}
          onGuide={() => void chat.guide()}
          attachments={chat.attachments}
          canAttach={chat.canAttach}
          attaching={chat.attaching}
          onAttach={(f) => void chat.attach(f)}
          onRemoveAttachment={chat.removeAttachment}
          onChange={chat.setInput}
          onSend={() => void chat.send()}
          onCancel={() => void chat.cancel()}
        />
      )}
    </>
  );
}

export function MobileApp(props: MobileAppProps): React.ReactElement {
  /**
   * 同源不变量：设备凭据是 HttpOnly cookie，`baseUrl` 为空（或与页面同源）时
   * fetch/EventSource 才会自动携带。Host 自己托管本页面，所以当前恒为 `""`。
   * 若将来要支持跨源 Host，必须同时改 CORS / `credentials:"include"` /
   * `withCredentials` / `SameSite=None; Secure` —— 不允许只改这里的 baseUrl。
   */
  const baseUrl = props.baseUrl ?? "";
  /**
   * 能力位与写模式：**只**由 `host.hello.capabilities` 决定（默认按远程第一版，
   * 兼容旧 Host；hello 回来后立刻换成服务器真实能力）。
   */
  const [caps, setCaps] = useState<Capabilities>(() => capabilitiesFor("remote"));
  const [writeAllowed, setWriteAllowed] = useState(true);
  const transportRef = useRef<SessionTransport | null>(null);
  /**
   * **静态**访问令牌（只可能是升级前留下的旧值）。
   *
   * 设备凭据不在 React 状态里：它是 HttpOnly cookie，由 Host 在 `pair.claim` 时下发，
   * 同源请求（含 EventSource）自动携带。UI 已经**没有**手填令牌入口；这里保留的值只有
   * 两个用途：兼容旧版本存过的静态令牌（Bearer），以及发现它对当前 Host 不再生效时
   * 清掉 localStorage。
   */
  const [staticToken, setStaticToken] = useState<string>(() => resolveHostToken());
  /** Host 要求凭据而本地没有（或已被撤销）：显示配对门，不显示"正在连接"死循环 */
  const [needsPairing, setNeedsPairing] = useState(false);
  /**
   * 本机凭据被 Host 拒绝（通常是 Host 重启换了凭据，而页面没重新加载）。
   *
   * 单独一个状态而不是复用 `needsPairing`：`local-auth` 模式没有匿名配对入口，
   * 回配对门只会得到一个永远失败的页面。
   */
  const [localAuthFailed, setLocalAuthFailed] = useState(false);
  /** 本机凭据（RPC 的 Bearer）；undefined = 远程/桌面形态，行为完全不变 */
  const localAuthToken = props.localAuth?.token;
  /** 配对成功后的强制重连（凭据可能没变：撤销后重新配一次也要重连） */
  const [connectNonce, setConnectNonce] = useState(0);
  const [ready, setReady] = useState(false);
  const [banner, setBanner] = useState("正在连接 Host…");
  const [sessions, setSessions] = useState<SessionSummaryView[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState("Codem Remote");
  const [runState, setRunState] = useState<string | null>(null);
  /**
   * 运行结束的"刷新令牌"：变更列表不轮询，只在 `run.finished/failed/cancelled`
   * （`runState` 从 running 变成别的）后重新取第一页。递增一个数字就够了 ——
   * 不引入第二套事件总线。
   */
  const [changesRefresh, setChangesRefresh] = useState(0);
  const previousRunState = useRef<string | null>(null);
  const [autoSendText, setAutoSendText] = useState<string | undefined>(undefined);
  const [filesOpen, setFilesOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** 平板/宽屏的列表折叠（内存态，不持久化：手机壳没有设置库，加 localStorage 就是新存储契约） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** 第三列页签与"当前选中的文件"（相对工作区路径） */
  const [detailTab, setDetailTab] = useState<DetailTab>("files");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  /**
   * 能力表里没有变更记录时，不能停在「变更」页签：页签本身都不渲染，
   * 停在 `changes` 会让第三列看起来空了（半套 UI）。切回「文件」。
   */
  useEffect(() => {
    if (!caps.changes && detailTab === "changes") setDetailTab("files");
  }, [caps.changes, detailTab]);

  function fail(e: unknown): void {
    setBanner(String((e as { message?: string })?.message ?? e));
  }

  useEffect(() => {
    const wasRunning = previousRunState.current === "running";
    previousRunState.current = runState;
    // 只认"running → 非 running"这一条边；首次挂载（null → null）不触发
    if (wasRunning && runState !== "running") setChangesRefresh((n) => n + 1);
  }, [runState]);

  useEffect(() => {
    // Android 键盘弹出：把输入区滚进可视区，避免被 IME 盖住
    const ta = document.querySelector("textarea");
    const onFocus = (): void => {
      window.setTimeout(() => ta?.scrollIntoView({ block: "end", behavior: "smooth" }), 250);
    };
    ta?.addEventListener("focus", onFocus);
    return () => ta?.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let disposed = false;
    /*
     * 本机凭据缺失/被拒时直接显示错误页：这时候连 hello 都必然 401，
     * 发出去只会多一次无用请求（也让"错误页"背后的网络活动显得可疑）。
     */
    if (props.localAuth?.problem) return;
    const client = createHostClient({
      baseUrl,
      staticToken: staticToken || undefined,
      localAuthToken,
      onStatus: (s) => {
        if (s === "connected" && !disposed) setReady(true);
      },
      onUnauthorized: (reason) => {
        if (disposed) return;
        /**
         * 401 / 撤销：本机凭据与远程凭据走**两条**路。
         *
         * 本机（`local-auth`）没有匿名配对入口 ⇒ 显示"凭据已失效"，让用户重新打开应用；
         * 远程仍旧回配对门。
         *
         * 撤销（reason=revoked）或迁移前残留的旧设备 token（现在不再被接受）都要清掉
         * localStorage：否则下次启动还会拿着已失效的凭据连一次再失败（用户看到的是
         * "转圈 → 报错"而不是配对门）。
         */
        setReady(false);
        if (localAuthToken) {
          setLocalAuthFailed(true);
          setBanner("");
          return;
        }
        setNeedsPairing(true);
        setBanner("");
        if (reason === "revoked" || staticToken) {
          clearHostToken();
          setStaticToken("");
        }
      },
    });
    const transport = remoteTransport(client);
    transportRef.current = transport;

    void (async () => {
      try {
        const hello = await transport.hello();
        if (disposed) return;
        /**
         * **唯一的写模式判据**：服务器实际开放了哪些方法。
         *
         * 旧 Host 不返回能力表（`undefined`）⇒ 按远程第一版处理（保持升级兼容）；
         * 网关 M2 返回 8 条（含 prompt.send/run.cancel/approval.*）⇒ 写模式；
         * 只读形态（能力表缺写/审批）⇒ 发送框不渲染，且服务端仍会拒绝写方法。
         */
        const supported = hello.capabilities ? hello.capabilities.supported : null;
        setCaps(capabilitiesFromMethods(supported));
        setWriteAllowed(canWriteSessions(supported));
        /**
         * 只信任**服务器确认过**的静态令牌。
         *
         * 迁移前设备 token 也存在同一个 localStorage 键里；如果 Host 是 `local` 模式
         * （没有 401），旧值会一直留下来，并在 SSE 连接时被当成静态令牌拼进 URL。
         * `hello.auth.kind !== "static"` 说明这个值没有起作用（旧 device token / 已失效），
         * 清掉并让 effect 以"无令牌"重跑。旧 Host 不返回 `auth` 时保留（无法判断，按兼容处理）。
         */
        if (staticToken && hello.auth && hello.auth.kind !== "static") {
          clearHostToken();
          setStaticToken("");
          return;
        }
        setReady(true);
        document.body.setAttribute("data-connected", "1");
        setSessions(await transport.listSessions());
        const params = new URLSearchParams(location.search);
        const openId = params.get("open");
        setBanner("");
        if (openId) {
          setSessionId(openId);
          if (params.get("selftest") === "1") setAutoSendText("请读取 index.html 的第一行并回答（selftest）");
        }
      } catch (e) {
        if (disposed) return;
        // 需要配对不是"错误"：pair.claim 是唯一的自举入口，应该显示配对门而不是红色横幅
        if (e instanceof HostRpcError && e.kind === "UNAUTHORIZED") {
          if (localAuthToken) {
            setLocalAuthFailed(true);
            setBanner("");
            return;
          }
          setNeedsPairing(true);
          setBanner("");
          return;
        }
        fail(e);
      }
    })();

    return () => {
      disposed = true;
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, staticToken, connectNonce, localAuthToken]);

  /**
   * 换会话 = 第三列回到默认：清掉上一会话的文件选择、页签回到「文件」。
   * 少了这一条，差异页签会指向上一会话的文件（路径相同也未必是同一个工作区）。
   */
  useEffect(() => {
    setSelectedFile(null);
    setDetailTab("files");
  }, [sessionId]);

  const transport = transportRef.current;

  /*
   * 本机凭据问题优先于配对门：`local-auth` 的 Host 不接受匿名 `pair.claim`，
   * 把用户送到配对门等于把唯一可行的动作（重新打开应用）藏起来。
   */
  if (props.localAuth?.problem) return <LocalAuthError problem={props.localAuth.problem} />;
  if (localAuthFailed) return <LocalAuthError problem="rejected" />;

  if (needsPairing) {
    return (
      <PairingGate
        baseUrl={baseUrl}
        onPaired={() => {
          /**
           * 设备凭据：`pair.claim` 的 `Set-Cookie` 已经落在浏览器里，**不保存任何值**；
           * 清掉可能残留的旧 token 后靠 nonce 重建连接（同源 cookie 自动带上）。
           */
          clearHostToken();
          setStaticToken("");
          setNeedsPairing(false);
          setReady(false);
          setBanner("正在连接 Host…");
          setConnectNonce((n) => n + 1);
        }}
      />
    );
  }

  return (
    <>
      <Header
        title={sessionId ? title : "Codem Remote"}
        state={runState}
        connected={ready}
        onBack={sessionId ? () => setSessionId(null) : undefined}
        onOpenFiles={caps.workspaceWrite ? () => setFilesOpen(true) : undefined}
        onOpenChanges={sessionId && caps.changes ? () => setChangesOpen(true) : undefined}
        onOpenInfo={() => setInfoOpen(true)}
        /* 只在选中会话时给折叠入口：没会话时「列表」就是首屏本身，藏起来没有意义 */
        onToggleSidebar={sessionId ? () => setSidebarCollapsed((v) => !v) : undefined}
        sidebarCollapsed={sidebarCollapsed}
      />
      {/* 宽屏三列（列表 280 + 对话 + 第三列）；窄屏单列：未选会话看列表，选中看对话 */}
      <SplitLayout
        inSession={Boolean(sessionId)}
        sidebarCollapsed={sidebarCollapsed}
        sidebar={
          <>
            {banner ? <Banner text={banner} /> : null}
            <SessionList
              sessions={sessions}
              query={query}
              onQueryChange={setQuery}
              onOpen={(id) => {
                setSessionId(id);
                setBanner("");
              }}
            />
            {caps.createSession && transport?.createSession ? (
              <button
                className="session"
                onClick={() => {
                  void (async () => {
                    try {
                      const created = await transport.createSession!("新会话");
                      setSessions((prev) => [created, ...prev]);
                      setSessionId(created.id);
                      setBanner("");
                    } catch (e) {
                      fail(e);
                    }
                  })();
                }}
              >
                ＋ 新建会话
              </button>
            ) : null}
          </>
        }
        chat={
          sessionId && transport ? (
            <MobileSession
              transport={transport}
              sessionId={sessionId}
              caps={caps}
              autoSendText={autoSendText}
              onRunState={setRunState}
              onTitle={setTitle}
              readOnly={!writeAllowed}
            />
          ) : (
            <div className="pick-session">
              {writeAllowed ? "选择一个会话，或点「＋ 新建会话」" : "选择一个会话查看桌面历史（只读）"}
            </div>
          )
        }
        detail={
          caps.workspaceWrite && transport ? (
            <WorkspaceDetail
              tab={detailTab}
              onSelectTab={setDetailTab}
              files={
                <FileBrowser
                  transport={transport}
                  onClose={() => setFilesOpen(false)}
                  inline
                  onSelectFile={setSelectedFile}
                />
              }
              diff={
                <WorkspaceDiffPane
                  transport={transport}
                  path={selectedFile}
                  onChooseFile={() => setDetailTab("files")}
                />
              }
              changes={
                sessionId && caps.changes ? (
                  <SessionChangesPane
                    transport={transport}
                    sessionId={sessionId}
                    refreshKey={changesRefresh}
                  />
                ) : null
              }
            />
          ) : null
        }
      />
      {changesOpen && sessionId && caps.changes && transport ? (
        <div className="file-browser" role="dialog" aria-label="workspace changes">
          <div className="file-browser-head">
            <button className="file-browser-back" onClick={() => setChangesOpen(false)} aria-label="back">
              ←
            </button>
            <span className="file-browser-path">变更</span>
            <button onClick={() => setChangesOpen(false)}>关闭</button>
          </div>
          <SessionChangesPane
            transport={transport}
            sessionId={sessionId}
            refreshKey={changesRefresh}
          />
        </div>
      ) : null}
      {filesOpen && caps.workspaceWrite && transport ? (
        <FileBrowser transport={transport} onClose={() => setFilesOpen(false)} />
      ) : null}
      {infoOpen && transport ? <InfoPanel transport={transport} onClose={() => setInfoOpen(false)} /> : null}
    </>
  );
}
