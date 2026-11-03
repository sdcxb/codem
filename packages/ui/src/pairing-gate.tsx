/**
 * 手机端配对门（D-7）—— `hello` 被 401 拒绝时显示。
 *
 * 设计取舍：
 * - **配对码只进请求体**：不进 URL、不进 localStorage、不打印到 console（配对码一次性、5 分钟）；
 * - **设备凭据由 Host 以 HttpOnly `Set-Cookie` 下发**：本组件拿不到明文，也不需要拿；
 *   配对成功后只通知上层"重建连接"（同源请求会自动带上 cookie）；
 * - **只有一次性配对码这一个入口**：静态 `CODEM_HOST_TOKEN` 仍由 Host/CLI 支持（桌面 break-glass），
 *   但不再暴露给手机页面 —— 少一条"长期凭据可以手输进 UI"的路径；
 * - 错误按 `HostRpcError.kind + details.reason` 给可行动文案，**不回显**提交的码。
 */
import * as React from "react";
import { useState } from "react";

import { METHODS, type PairClaimResult } from "../../protocol/src/index";
import { HostRpcError, createHostClient } from "./host-client";

export interface PairingGateProps {
  baseUrl: string;
  /**
   * 配对成功：交给上层重建连接。
   *
   * **无参数**——设备凭据已经在 HttpOnly cookie 里，上层不保存任何东西；
   * 这里也不再有"手填静态令牌"的第二条返回值。
   */
  onPaired: () => void;
}

type PairReason = "invalid" | "expired" | "used" | "locked" | "rate_limited" | "device_limit";

const REASON_TEXT: Record<PairReason, string> = {
  invalid: "配对码不正确，请核对电脑上显示的 6 位数字",
  expired: "配对码已过期，请在电脑上重新生成",
  used: "这个配对码已经用过了，请在电脑上重新生成",
  locked: "这个配对码错误次数过多已锁定，请在电脑上重新生成",
  rate_limited: "尝试过于频繁，请稍后再试",
  device_limit: "已配对设备达到上限，请先在电脑上撤销一台设备",
};

function platformOf(): "android" | "ios" | "web" {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return "web";
}

function messageFor(e: unknown): string {
  if (e instanceof HostRpcError) {
    const details = (e.details ?? {}) as { reason?: string; retryAfterMs?: number };
    const reason = details.reason as PairReason | undefined;
    if (reason && reason in REASON_TEXT) {
      if (reason === "rate_limited" && typeof details.retryAfterMs === "number") {
        return `${REASON_TEXT.rate_limited}（约 ${Math.max(1, Math.ceil(details.retryAfterMs / 1000))} 秒）`;
      }
      return REASON_TEXT[reason];
    }
    if (e.kind === "UNAUTHORIZED") return "配对失败：凭据无效或已过期";
    if (e.kind === "BUSY") return "电脑正忙，请稍后再试";
  }
  return `连不上这台电脑：${(e as Error)?.message ?? String(e)}`;
}

export function PairingGate(props: PairingGateProps): React.ReactElement {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("我的手机");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function claim(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalized = code.replace(/[\s-]/g, "");
    if (!/^[0-9]{6}$/.test(normalized)) {
      setError("请输入电脑上显示的 6 位数字配对码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const client = createHostClient({ baseUrl: props.baseUrl });
      await client.rpc<PairClaimResult>(METHODS.pairClaim, {
        code: normalized,
        deviceName: deviceName.trim() || undefined,
        platform: platformOf(),
      });
      // 凭据已在 Set-Cookie 里；不传值，避免上层误以为还需要保存 token
      props.onPaired();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pairing-gate" data-testid="pairing-gate" style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }}>
      <div style={{ fontWeight: 600 }}>连接这台电脑</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
        在电脑的「设置 → 连接手机」里生成 6 位配对码，然后在这里输入。配对码 5 分钟内有效、只能用一次。
      </div>
      <form onSubmit={(e) => void claim(e)} style={{ display: "grid", gap: 8 }}>
        <input
          data-testid="pairing-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="6 位配对码"
          aria-label="配对码"
          maxLength={16}
          disabled={busy}
        />
        <input
          data-testid="pairing-name"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="这台手机的名字"
          aria-label="设备名"
          maxLength={64}
          disabled={busy}
        />
        <button type="submit" data-testid="pairing-submit" disabled={busy}>
          {busy ? "配对中…" : "配对"}
        </button>
      </form>
      {error ? (
        <div data-testid="pairing-error" role="alert" style={{ color: "var(--error, #c33)", fontSize: 13 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
