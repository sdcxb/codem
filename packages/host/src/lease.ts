/**
 * 单写者租约（D-5）：**后到者接管 + 二次确认**。
 *
 * 背景：手机与另一台电脑可能同时连同一个 Host。写操作（发 prompt、取消、审批）只允许一个
 * 持有者，否则会出现"两边都以为自己在驱动同一个回合"。
 *
 * 语义（全部可单测，不依赖 HTTP）：
 * - `hello(clientId)`：无人持有/已过期/本人 ⇒ 授予（续期）；他人持有 ⇒ **不授予**，返回现状；
 * - `takeover(clientId, confirm=false)`：先返回 `needsConfirmation`（UI 弹"另一台设备正在使用"）；
 *   再以 `confirm=true` 调用才真正接管，并返回前任（便于 UI 提示"已从 X 接管"）；
 * - 租约 TTL：默认 90s；持有者每次 `hello` 续期；过期后任意客户端可无确认获得。
 */
export interface LeaseView {
  holder: "none" | "remote";
  clientId?: string;
  deviceName?: string;
  expiresAt?: number;
}

export interface LeaseHelloResult {
  granted: boolean;
  lease: LeaseView;
  /** 他人持有时：是否可通过二次确认接管 */
  canTakeover?: boolean;
}

export interface LeaseTakeoverResult {
  granted: boolean;
  needsConfirmation: boolean;
  lease: LeaseView;
  previousHolder?: string;
}

export class LeaseManager {
  private holder: string | null = null;
  private deviceName: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly ttlMs = 90_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 当前有效租约（过期视为空，但不在这里清理写状态以外的信息） */
  view(): LeaseView {
    if (!this.holder || this.expiresAt <= this.now()) return { holder: "none" };
    return {
      holder: "remote",
      clientId: this.holder,
      ...(this.deviceName ? { deviceName: this.deviceName } : {}),
      expiresAt: this.expiresAt,
    };
  }

  hello(clientId: string, deviceName?: string): LeaseHelloResult {
    const current = this.view();
    if (current.holder === "none" || current.clientId === clientId) {
      this.grant(clientId, deviceName);
      return { granted: true, lease: this.view() };
    }
    return { granted: false, lease: current, canTakeover: true };
  }

  takeover(clientId: string, confirm: boolean, deviceName?: string): LeaseTakeoverResult {
    const current = this.view();
    if (current.holder === "none" || current.clientId === clientId) {
      this.grant(clientId, deviceName);
      return { granted: true, needsConfirmation: false, lease: this.view() };
    }
    if (!confirm) {
      return {
        granted: false,
        needsConfirmation: true,
        lease: current,
        ...(current.clientId ? { previousHolder: current.clientId } : {}),
      };
    }
    const previous = current.clientId;
    this.grant(clientId, deviceName);
    return {
      granted: true,
      needsConfirmation: false,
      lease: this.view(),
      ...(previous ? { previousHolder: previous } : {}),
    };
  }

  release(clientId: string): LeaseView {
    if (this.holder === clientId) {
      this.holder = null;
      this.deviceName = null;
      this.expiresAt = 0;
    }
    return this.view();
  }

  private grant(clientId: string, deviceName?: string): void {
    this.holder = clientId;
    this.deviceName = deviceName?.trim() || null;
    this.expiresAt = this.now() + this.ttlMs;
  }
}
