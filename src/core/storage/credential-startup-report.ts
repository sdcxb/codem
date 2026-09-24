/**
 * 启动期**凭据状态**的可见性（第 89 轮）。
 *
 * ## 这个模块为什么存在（真机取证）
 *
 * 第 88 轮的隔离钻取（副本库 + `CODEM_DB_PATH` 启动装机版）把这一幕真的跑出来了：
 * 用户的密钥**解不开**（换了 Windows 账户或换了机器，DPAPI 与本账户绑定），
 * 于是这些 provider 实际上**用不了**。当时界面上：
 *
 * - **一条提示都没有**（横幅里那条是"凭据普查"的另一件事）；
 * - 只有**控制台**两行 `[secrets] N 个 provider 的密钥解不开…`；
 * - 用户唯一能看到的地方是**主动**打开「设置 → 安全」时的那行
 *   「其中 N 个**本账户解不开**（密文已保留）——请重新填写这些 API Key」。
 *
 * 也就是说：**一个会让 API Key 全部失效的状态，只有翻设置页才能发现**。
 * 这与仓库级契约（`persist-failure.ts`：「失败必须可见」）相冲突，所以把这段
 * 决策从 `App.tsx` 里抽出来，做成**可单测**的函数，并把四种状态分别归到正确的语气：
 *
 * | 状态 | 事实 | 语气 |
 * | --- | --- | --- |
 * | `hydrated.failed > 0` | 密钥**解不开** ⇒ 这些 provider 用不了 | **失败**（用户的 key 真的没生效） |
 * | `migrated.failed > 0` | 明文**没被封存**（一个失败就整体不动） | **失败**（安全动作没生效） |
 * | `migrated.skippedUnavailable > 0` | 这台机器**没有**可用的系统加密 ⇒ 只能明文 | **提醒**（不是失败，是环境事实） |
 * | `residue.attempted && !vacuumed` | 行级封存生效，但**字节级残留**没回收 | **提醒**（要人判断的风险，不是失败） |
 *
 * ## 为什么"上报归一"要单独测
 *
 * 这段以前是 `App.tsx` 里四段 `console.warn`。搬进来之后，"开机到底会不会打扰用户"
 * 变成可断言的：**一切正常时一行上报都不许有**（SCV-4 反向对照），
 * 而四种异常必须各自可达、语气不许串（失败不许说成提醒、反之亦然）。
 */

import { reportActionFailure, reportAdvisory } from "./persist-failure";

/** `ensureSecretsHydrated()` 的结果里本模块用到的部分 */
export interface HydrateLike {
  unsealed: number;
  failed: number;
  backend: boolean;
  settingsReady: boolean;
}

/** `migrateProviderKeysToSealed()` 的结果里本模块用到的部分 */
export interface MigrateLike {
  sealed: number;
  failed: number;
  skippedUnavailable: number;
  skippedByChoice: number;
  cleanedDuplicate: number;
}

/** `reclaimSealedPlaintextResidue()` 的结果里本模块用到的部分 */
export interface ResidueLike {
  attempted: boolean;
  vacuumed: boolean;
  reason?: string;
}

export interface CredentialStartupInput {
  hydrated: HydrateLike;
  migrated: MigrateLike;
  residue?: ResidueLike;
}

export interface CredentialStartupReport {
  /** 走了"失败"通道的区域（用户的 key/保护真的没生效） */
  failures: string[];
  /** 走了"提醒"通道的区域（需要知道，但不是失败） */
  advisories: string[];
  /** 本次是否产生过任何用户可见上报（SCV-4 用它断言"正常时不打扰"） */
  reported: boolean;
}

/**
 * 把启动期的凭据状态**如实**上报到用户可见通道（幂等由通道自身按 area 去重）。
 *
 * 只在真有异常时上报：正常路径（没有解不开的密钥、没有待封存的明文、没有残留）
 * **一行上报都不产生** —— 避免"开机就弹一条不知道是什么的东西"。
 */
export function reportCredentialStartupIssues(input: CredentialStartupInput): CredentialStartupReport {
  const out: CredentialStartupReport = { failures: [], advisories: [], reported: false };
  const { hydrated, migrated, residue } = input;

  // ① 密钥**解不开**：这些 provider 实际上用不了 —— 这是失败，必须让用户看见
  if (hydrated.failed > 0) {
    reportActionFailure(
      "secrets.unseal",
      new Error(`${hydrated.failed} 个 provider 的密钥解不开（密文已保留，未被删除）`),
      "密文由**另一台机器或另一个 Windows 账户**封存（系统加密与本机/本账户绑定），本机解不开；" +
        "已保存的密文不会被删除",
      {
        title: "凭据：本机解不开已保存的密钥",
        consequence:
          "这些 provider 现在**用不了**（界面显示已配置、请求却没有密钥）。" +
          "请在这台机器上重新填写它们的 API Key；「设置 → 安全」里有同一处状态与入口。",
      },
    );
    out.failures.push("secrets.unseal");
    out.reported = true;
  }

  // ② 明文**没被封存**（一个失败就整体不动）：安全动作没生效 —— 也是失败
  if (migrated.failed > 0) {
    reportActionFailure(
      "secrets.migrate",
      new Error(`封存失败，${migrated.failed} 个 provider 的密钥保持明文（本次未改动任何密钥）`),
      "出于安全，**一个失败就整体不动**（避免「一半明文一半密文」）：本次没有改动任何密钥，下次启动会重试",
      {
        title: "凭据：本次没能把密钥改成系统加密保存",
        consequence:
          "密钥仍然是**明文**保存在本机库里（与改动前一样）。若这台机器或它的备份可能外流，建议轮换密钥。",
      },
    );
    out.failures.push("secrets.migrate");
    out.reported = true;
  }

  // ③ 这台机器**没有**可用的系统加密：是环境事实，不是失败
  if (migrated.skippedUnavailable > 0) {
    reportAdvisory("secrets.noBackend", `这台机器没有可用的系统加密（DPAPI），${migrated.skippedUnavailable} 个 provider 的密钥只能保持明文`, {
      title: "凭据：这台机器无法加密保存密钥（仍是明文）",
      nextStep:
        "密钥以**明文**保存在本机库里（这是本机存储的既有设计）；" +
        "若该机器或其备份可能外流，建议轮换。这台机器上没有可用的系统加密，换到支持的平台后会自动封存。",
    });
    out.advisories.push("secrets.noBackend");
    out.reported = true;
  }

  // ④ 行级封存生效，但**字节级残留**没回收：要人判断的风险，不是失败
  if (residue?.attempted && !residue.vacuumed) {
    reportAdvisory("secrets.residue", `旧明文可能仍残留在库文件的空闲页 / WAL 里（${residue.reason ?? "原因未知"}）`, {
      title: "凭据：旧明文的字节残留没能回收",
      nextStep:
        "行级封存**已经生效**（settings 里读到的是密文）；只是被替换掉的那份明文字节可能还留在库文件的空闲页/旧帧里。" +
        "若这个库文件或其备份可能外流，建议轮换密钥。",
    });
    out.advisories.push("secrets.residue");
    out.reported = true;
  }

  return out;
}
