/**
 * 敏感读取审批的**纯状态**（没有 Node import，桌面渲染层也能引）。
 *
 * 这里只放"批准一次覆盖什么、多久过期、一次性消费"这三件事：
 * - `SensitiveApprovalGrant`：工具 + 精确键 + 文件清单；
 * - `ApprovalGrantStore`：TTL、一次性消费、懒清理；
 * - `SensitiveApprovalRegistration` / `SensitiveApprovalRegistrar`：待答复审批与 grant 的登记形状。
 *
 * 为什么从 `sensitive-access.ts` 拆出来：那份实现要读文件、resolve 路径，所以 import 了
 * `node:fs`；而桌面网关跑在 WebView 里（没有 Node），却必须复用**同一条**审批语义。
 * 判定/规则表在 `sensitive-paths.ts`，状态机在这里，`sensitive-access.ts` 只负责
 * 把两者接到真实文件读取上。
 */
import type { ApprovalRequestView } from "../../protocol/src/index";

/** 审批/授权有效期：5 分钟。过期后必须重新发起（不要用"永久批准"） */
export const SENSITIVE_APPROVAL_TTL_MS = 5 * 60_000;

/** 同时挂着的 RPC 敏感审批上限（防止客户端只发不答把内存撑爆） */
export const SENSITIVE_APPROVAL_MAX_PENDING = 32;

export type SensitiveApprovalTool = "workspace.read" | "workspace.diff";

/** 一次批准覆盖的内容：工具 + 键 + 文件清单 */
export interface SensitiveApprovalGrant {
  tool: SensitiveApprovalTool;
  /**
   * 精确匹配键：
   * - read：工作区相对路径；
   * - diff：`<路径>|<git 基线>`。
   */
  key: string;
  /** 本次批准覆盖的敏感文件（工作区相对路径），批准后重试时必须全部仍被覆盖 */
  files: string[];
}

interface StoredGrant extends SensitiveApprovalGrant {
  expiresAt: number;
}

/**
 * 一次性授权表。**没有持久化**：Host/网关重启即清空（审批不是历史记录）。
 */
export class ApprovalGrantStore {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  grant(approvalId: string, grant: SensitiveApprovalGrant, ttlMs = SENSITIVE_APPROVAL_TTL_MS): void {
    this.prune();
    this.grants.set(approvalId, { ...grant, files: [...grant.files], expiresAt: this.now() + ttlMs });
  }

  /**
   * 消费一次 grant：命中（工具/键一致且未过期）返回 grant 并删除；否则删除该 ID 并返回 null。
   *
   * 无论命中与否都删：同一个 approvalId 第二次使用必须失败（一次性）。
   */
  consume(approvalId: string, tool: SensitiveApprovalTool, key: string): SensitiveApprovalGrant | null {
    const stored = this.grants.get(approvalId);
    if (!stored) return null;
    this.grants.delete(approvalId);
    if (stored.expiresAt <= this.now()) return null;
    if (stored.tool !== tool || stored.key !== key) return null;
    return { tool: stored.tool, key: stored.key, files: [...stored.files] };
  }

  delete(approvalId: string): void {
    this.grants.delete(approvalId);
  }

  size(): number {
    this.prune();
    return this.grants.size;
  }

  /** 清掉过期项（`grant`/`size` 时顺带调用；读路径不依赖定时器） */
  prune(): void {
    const now = this.now();
    for (const [id, g] of this.grants) {
      if (g.expiresAt <= now) this.grants.delete(id);
    }
  }
}

export interface SensitiveApprovalRegistration {
  /** 待答复审批（客户端通过 `approval.list` / `approval.respond` 处理） */
  view: ApprovalRequestView;
  /** 批准后要登记的 grant（拒绝时不登记） */
  grant: SensitiveApprovalGrant;
}

/** 登记一个待答复审批（**不阻塞**） */
export type SensitiveApprovalRegistrar = (registration: SensitiveApprovalRegistration) => void;
