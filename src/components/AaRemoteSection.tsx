/**
 * 「手机远程」—— Agents Anywhere 登录入口（阶段 N1–N3）。
 *
 * ## 为什么单独一个组件
 *
 * 用户口径是**简单**：这一屏只做三件事 —— 选服务器、填账号密码、点连接。
 * 把它做成独立组件，是为了不把那些机制（PKCE、回环监听、connector 协议）
 * 混进已有的 LAN 面板里 —— 那些东西用户不需要知道。
 *
 * ## 默认连它的云（与 DSH 一致）
 *
 * `AA 默认 = https://web.agents-anywhere.com`（它的 `CLOUD_API_BASE_URL`）。
 * 所以默认**不填任何地址**就能用；"自建服务器"是一个可选开关。
 */
import { useState, useEffect, useCallback } from "react";

async function invokeCmd(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const w = window as any;
  if (!w.__TAURI__?.core?.invoke) throw new Error("no tauri");
  return w.__TAURI__.core.invoke(cmd, args);
}

interface AcctView {
  serverUrl?: string;
  signedIn?: boolean;
  tokenValid?: boolean;
  profile?: { userId?: string; displayName?: string; email?: string } | null;
  deviceId?: string | null;
  hasDeviceToken?: boolean;
}

interface ConnView {
  running?: boolean;
  connected?: boolean;
  lastError?: string | null;
  credentialsRevoked?: boolean;
  requestsServed?: number;
}

export function AaRemoteSection({ zh }: { zh: boolean }) {
  const [acct, setAcct] = useState<AcctView>({});
  const [conn, setConn] = useState<ConnView>({});
  const [custom, setCustom] = useState(false);
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  /**
   * 昵称：**注册时服务端必填**（1-64 字符）。
   *
   * 这个字段我先前漏了 —— 用户点"注册并登录"撞到
   * `display name must be 1-64 characters (HTTP 422)`，
   * 而界面上根本没有输入它的地方。**必填项必须都有入口。**
   */
  const [displayName, setDisplayName] = useState("");
  /** 邮箱验证码：只有服务端启用了邮件验证时才需要，所以默认折叠。 */
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const a = await invokeCmd("aa_account_status");
      setAcct(a || {});
      if (a?.serverUrl && a.serverUrl !== "https://web.agents-anywhere.com") {
        setCustom(true);
        setUrl((u) => u || String(a.serverUrl));
      }
      const c = await invokeCmd("aa_connector_status");
      setConn(c || {});
    } catch {
      /* 不在 Tauri 里（浏览器预览）：保持空态，不报错打扰 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      const text = typeof e === "string" ? e : e?.message || String(e);
      /**
       * 服务端要验证码时**不要只是报错**。
       *
       * 事故记录：用户点「注册并登录」拿到 `invalid or expired verification code` ——
       * 因为验证码那一行**默认折叠着**，他既没有入口去拿码，也不知道需要码。
       * （更深一层：我的命令签名里**根本没有 code 参数**，所以哪怕他填了也会被静默丢掉
       * —— 两头看起来都对，中间少了一节。）
       *
       * 现在这里**对服务端的话作出反应**：展开验证码那一行，并**直接替他发一封码**。
       * 这比"让他自己猜为什么需要验证码"好得多。
       */
      const needsCode = /verification code|验证码/i.test(text);
      if (needsCode && email.trim()) {
        setShowCode(true);
        setMsg(zh
          ? "这个服务器需要邮箱验证码：已为你发送，请查收邮箱后填入下面的验证码再试"
          : "This server needs an email code — we sent one. Check your inbox, fill it in below and retry");
        try {
          await invokeCmd("aa_account_send_code", {
            serverUrl: custom ? url.trim() : null,
            email: email.trim(),
          });
        } catch (sendErr: any) {
          // 发不出去时，把**服务端对"发码"这件事的原话**显示出来（那才是有用的信息）
          setErr(typeof sendErr === "string" ? sendErr : sendErr?.message || String(sendErr));
        }
      } else {
        setErr(text);
      }
    } finally {
      setBusy(false);
    }
  };

  const doLogin = (register: boolean) =>
    act(async () => {
      await invokeCmd("aa_account_login", {
        serverUrl: custom ? url.trim() : null,
        email: email.trim(),
        password,
        register,
        displayName: displayName.trim() || null,
        setupToken: setupToken.trim() || null,
        code: code.trim() || null,
      });
      setMsg(register ? (zh ? "已注册并登录" : "Registered and signed in") : (zh ? "已登录" : "Signed in"));
    });

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "7px 10px", borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
    color: "var(--text-primary)", fontSize: 'var(--fs-sm)',
  };
  const btnStyle: React.CSSProperties = {
    padding: "7px 14px", borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
    color: "var(--text-primary)", fontSize: 'var(--fs-sm)', cursor: busy ? "default" : "pointer",
  };

  // 状态一行说清：优先报"连上了没有"，其次"登录了没有"
  const phase = conn.credentialsRevoked
    ? (zh ? "凭据失效，请重新登录" : "Credentials revoked — sign in again")
    : conn.connected
      ? (zh ? "已连接" : "Connected")
      : conn.running
        ? (zh ? "正在连接…" : "Connecting…")
        : acct.signedIn
          ? (zh ? "已登录，未连接" : "Signed in, not connected")
          : (zh ? "未登录" : "Not signed in");

  return (
    <div className="setting-group" data-testid="aa-remote">
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, marginBottom: 6 }}>
        {zh ? "手机远程（Agents Anywhere）" : "Phone remote (Agents Anywhere)"}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {zh
          ? "登录 Agents Anywhere 后，这台电脑会注册成一台设备；手机用同一个账号登录官方 App/网页就能看到并操作它的会话。默认用官方服务，也可以填自己的服务器。"
          : "Sign in to Agents Anywhere and this computer registers as a device; sign in with the same account on your phone (official app/web) to see and drive its sessions. Official service by default; you can point it at your own server."}
      </div>

      {/* 状态 */}
      <div data-testid="aa-phase" data-connected={conn.connected ? "1" : "0"} data-running={conn.running ? "1" : "0"}
        style={{ fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{phase}</span>
        {acct.profile?.displayName || acct.profile?.email ? (
          <span style={{ color: "var(--text-muted)" }}>
            {"　"}{acct.profile.displayName || acct.profile.email}
          </span>
        ) : null}
        {conn.requestsServed ? (
          <span style={{ color: "var(--text-muted)" }}>{"　"}{zh ? `已服务 ${conn.requestsServed} 次` : `${conn.requestsServed} served`}</span>
        ) : null}
      </div>
      {conn.lastError && !conn.connected ? (
        <div data-testid="aa-error" style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginBottom: 8, wordBreak: "break-all" }}>
          {conn.lastError}
        </div>
      ) : null}

      {/* 服务器：默认官方，可切自建 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, fontSize: 'var(--fs-sm)' }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" name="aa-server" checked={!custom} onChange={() => setCustom(false)} />
          {zh ? "官方服务（默认）" : "Official (default)"}
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" name="aa-server" checked={custom} onChange={() => setCustom(true)} />
          {zh ? "自建服务器" : "Own server"}
        </label>
      </div>
      {custom && (
        <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
          <input data-testid="aa-url" style={inputStyle} placeholder={zh ? "服务器地址，例如 https://my-server.com" : "Server URL, e.g. https://my-server.com"}
            value={url} onChange={(e) => setUrl(e.target.value)} />
          <input data-testid="aa-setup-token" style={inputStyle} placeholder={zh ? "首次安装令牌（服务端日志里的 setup-token，可留空）" : "First-run setup token (from server log; optional)"}
            value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
        </div>
      )}

      {/* 账号 */}
      <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
        <input data-testid="aa-email" style={inputStyle} placeholder={zh ? "邮箱" : "Email"} value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        <input data-testid="aa-password" style={inputStyle} type="password" placeholder={zh ? "密码" : "Password"} value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {/* 注册要用；登录不需要 —— 但**必须有个地方填**（服务端注册时必填） */}
        <input data-testid="aa-display-name" style={inputStyle}
          placeholder={zh ? "昵称（注册时需要，1-64 个字符）" : "Display name (needed to register, 1-64 chars)"}
          value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        {showCode && (
          <div style={{ display: "flex", gap: 6 }}>
            <input data-testid="aa-code" style={inputStyle} placeholder={zh ? "邮箱验证码（6 位）" : "Email code (6 digits)"}
              value={code} onChange={(e) => setCode(e.target.value)} />
            <button data-testid="aa-send-code" style={btnStyle} disabled={busy || !email.trim()}
              onClick={() => act(async () => {
                await invokeCmd("aa_account_send_code", { serverUrl: custom ? url.trim() : null, email: email.trim() });
                setMsg(zh ? "验证码已发送，请查收邮箱" : "Code sent — check your inbox");
              })}>{zh ? "发送" : "Send"}</button>
          </div>
        )}
        <button type="button" data-testid="aa-toggle-code"
          style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 'var(--fs-xs)', cursor: "pointer", textAlign: "left", padding: 0 }}
          onClick={() => setShowCode((v) => !v)}>
          {showCode ? (zh ? "▲ 这个服务器不需要验证码" : "▲ This server needs no code") : (zh ? "▼ 这个服务器需要邮箱验证码？" : "▼ Does this server need an email code?")}
        </button>
      </div>

      {/* 动作 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!acct.signedIn ? (
          <>
            <button data-testid="aa-login" style={btnStyle} disabled={busy || !email.trim() || !password}
              onClick={() => doLogin(false)}>{zh ? "登录" : "Sign in"}</button>
            <button data-testid="aa-register" style={btnStyle}
              disabled={busy || !email.trim() || !password || !displayName.trim()}
              title={!displayName.trim() ? (zh ? "注册需要先填昵称" : "A display name is required to register") : undefined}
              onClick={() => doLogin(true)}>{zh ? "注册并登录" : "Register & sign in"}</button>
          </>
        ) : (
          <>
            <button data-testid="aa-connect" style={btnStyle} disabled={busy || Boolean(conn.connected)}
              onClick={() => act(async () => {
                await invokeCmd("aa_connect", {});
                setMsg(zh ? "已连接" : "Connected");
              })}>{conn.connected ? (zh ? "已连接" : "Connected") : (zh ? "连接" : "Connect")}</button>
            <button data-testid="aa-disconnect" style={btnStyle} disabled={busy}
              onClick={() => act(async () => { await invokeCmd("aa_connector_stop"); })}>
              {zh ? "断开" : "Disconnect"}
            </button>
            <button data-testid="aa-logout" style={btnStyle} disabled={busy}
              onClick={() => act(async () => { await invokeCmd("aa_account_logout"); setPassword(""); })}>
              {zh ? "退出登录" : "Sign out"}
            </button>
          </>
        )}
      </div>

      {msg && <div style={{ fontSize: 'var(--fs-xs)', color: "var(--success)", marginTop: 6 }}>{msg}</div>}
      {err && <div data-testid="aa-login-error" style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 6, wordBreak: "break-all" }}>{err}</div>}
    </div>
  );
}
