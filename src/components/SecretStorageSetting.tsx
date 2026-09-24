/**
 * 「设置 → 安全 → API 密钥存储」（第 62 轮）。
 *
 * ## 为什么单独一个组件
 *
 * `SettingsPanel.tsx` 已经 3200+ 行；而且这块逻辑**必须能被单独测**——
 * 它管的是"用户能不能把密钥退回明文"，属于安全边界，不该埋在巨型组件里靠人眼审。
 *
 * ## 这个组件关掉的缺口（第 62 轮，自查发现的）
 *
 * `codem-secrets-plaintext` 这个回退开关此前**只有读点、没有写入方**：
 * 也就是说方案里写的"可回退"当时是**不存在的**——那个键永远是默认值，
 * `migrateProviderKeysToSealed()` 里的 `skippedByChoice` 分支**永远不可达**，
 * 而"用户可以显式选择明文"这句话写在方案里、界面上一处都没有。
 * `settings-keys-symmetry.test.ts` 的 SKEY-2 直接把这条报了出来（这就是检测器的价值）。
 *
 * 现在这个开关有**真写入方**（本组件的勾选框）+ **真回退动作**
 * （`revertSealedKeysToPlaintext`：把已封存的密文解回明文写进 settings）。
 *
 * ## 界面纪律
 *
 * 1. **不许自己猜状态**：一切形态（明文几个/密文几个/解不开几个/后端可不可用）
 *    都来自 `secretStorageStatus()`，那是磁盘上的实况；
 * 2. **不许假成功**：回退可能整体失败（例如密文是另一个 Windows 账户封的），
 *    这时必须说"没改动"并给出下一步，而不是显示"已切回明文"；
 * 3. **危险动作要确认**：开明文会让密钥重新落盘，先问一次。
 */

import { useCallback, useEffect, useState } from "react";

import { removeSetting, setSettingJSON } from "../core/storage/settings";
import { confirmDialog } from "../core/ui/native-dialog";
import {
  isSealAvailable,
  migrateProviderKeysToSealed,
  PLAINTEXT_FALLBACK_KEY,
  revertSealedKeysToPlaintext,
  secretStorageStatus,
  type SecretStorageStatus,
} from "../core/storage/secret-store";

export interface SecretStorageSettingProps {
  lang: "zh" | "en";
}

export function SecretStorageSetting({ lang }: SecretStorageSettingProps) {
  const zh = lang === "zh";
  const [status, setStatus] = useState<SecretStorageStatus>(() => secretStorageStatus());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => setStatus(secretStorageStatus()), []);

  useEffect(() => {
    let alive = true;
    // 后端结论在启动流程里才被问出来；这里补问一次，让"这台机器能不能加密"成为界面上的事实。
    void isSealAvailable().then(() => {
      if (alive) refresh();
    });
    const onChange = () => refresh();
    window.addEventListener("codem-settings-changed", onChange);
    return () => {
      alive = false;
      window.removeEventListener("codem-settings-changed", onChange);
    };
  }, [refresh]);

  const onToggle = useCallback(
    async (next: boolean) => {
      if (busy) return;
      if (next) {
        /*
         * 第 72 轮：原来是 fail-open —— `typeof window.confirm !== "function" || window.confirm(...)`，
         * 也就是"没有确认框就当用户同意"，直接把明文保存打开。
         * 而 Tauri 的 dialog 插件把 `window.confirm` 换成了异步调用（返回 Promise，恒为真），
         * 所以这个式子在生产里**永远成立**：开关一点就开、用户根本没被问过。
         * 现在统一走 `confirmDialog`：只有明确的 `true` 才算同意（拿不到答案 = 不开）。
         */
        const ok = await confirmDialog(
          zh
            ? "开启后，API 密钥会以明文保存在本地数据库里（不再使用 Windows 加密）。\n\n" +
                "已加密的密钥会被解回明文——这一步不可撤销（可以再关掉重新加密）。\n\n确定要开启吗？"
            : "When enabled, API keys are stored as plaintext in the local database (no Windows encryption).\n\n" +
                "Already-sealed keys will be decrypted back to plaintext. Continue?",
        );
        if (!ok) return;

        setBusy(true);
        setNote(null);
        try {
          // 顺序写死：先落开关（回退动作会检查它），再回退。反了就会被闸门拒绝。
          setSettingJSON(PLAINTEXT_FALLBACK_KEY, true);
          const out = await revertSealedKeysToPlaintext();
          if (out.reverted > 0) {
            setNote(zh ? `已把 ${out.reverted} 个密钥解回明文（此后不再加密保存）。` : `Reverted ${out.reverted} key(s) to plaintext.`);
          } else if (out.reason === "nothing") {
            setNote(zh ? "当前没有已加密的密钥，之后新填的密钥会以明文保存。" : "No sealed keys present; new keys will be stored as plaintext.");
          } else if (out.reason === "unreadable") {
            // 说清"没改动"，并给出下一步，不允许含糊
            setNote(
              zh
                ? `有 ${out.failed} 个密钥解不开（密文已保留、本次未改动任何密钥）——多半是换了 Windows 账户或换了机器，请重新填写这些 API Key。`
                : `${out.failed} key(s) could not be decrypted (nothing changed). Please re-enter them.`,
            );
          } else if (out.reason === "backend-missing") {
            setNote(zh ? `这台机器没有可用的系统加密，${out.failed} 个密钥解不开（密文已保留）。` : `No OS encryption available; ${out.failed} key(s) could not be decrypted.`);
          } else {
            setNote(zh ? "开关没能生效（设置未保存成功），密钥保持原样。" : "The switch did not take effect; keys unchanged.");
          }
        } catch (e) {
          setNote(zh ? `开启失败（密钥保持原样）：${String(e)}` : `Failed (keys unchanged): ${String(e)}`);
        } finally {
          setBusy(false);
          refresh();
          window.dispatchEvent(new Event("codem-settings-changed"));
        }
        return;
      }

      // 关掉明文回退 ⇒ 顺手做一次迁移（用户不必自己去"重新加密"）
      setBusy(true);
      setNote(null);
      try {
        removeSetting(PLAINTEXT_FALLBACK_KEY);
        const out = await migrateProviderKeysToSealed();
        if (out.sealed > 0) {
          setNote(zh ? `已把 ${out.sealed} 个密钥改为系统加密保存。` : `Sealed ${out.sealed} key(s).`);
        } else if (out.skippedUnavailable > 0) {
          setNote(
            zh
              ? `这台机器没有可用的系统加密（DPAPI），${out.skippedUnavailable} 个密钥只能保持明文——这不是失败，是环境限制。`
              : `No OS encryption available; ${out.skippedUnavailable} key(s) stay plaintext.`,
          );
        } else if (out.failed > 0) {
          setNote(
            zh
              ? `封存失败：${out.failed} 个密钥保持明文（出于安全，一个失败就整体不动，下次启动会重试）。`
              : `Sealing failed for ${out.failed} key(s); nothing changed.`,
          );
        } else {
          setNote(zh ? "当前没有明文密钥需要加密。" : "No plaintext keys to seal.");
        }
      } catch (e) {
        setNote(zh ? `加密失败（密钥保持原样）：${String(e)}` : `Failed (keys unchanged): ${String(e)}`);
      } finally {
        setBusy(false);
        refresh();
        window.dispatchEvent(new Event("codem-settings-changed"));
      }
    },
    [busy, refresh, zh],
  );

  /** 状态一句话（只描述事实，不给建议式承诺） */
  const statusText = (() => {
    /**
     * ⚠️ 先判"读没读到"，再判内容。
     * 设置面还没预热时 `secretStorageStatus()` 的三个计数都是 0 —— 那是**"不知道"**，
     * 不是"没有密钥"。这里若显示"当前没有已保存的密钥"，就是本仓库最怕的那种
     * "读失败塌成没有数据"的假话。
     */
    if (!status.settingsReady) {
      return zh ? "还没读到本机的设置（稍后会重试）——此刻不显示密钥状态。" : "Settings not readable yet; retrying.";
    }
    if (status.plaintextByChoice) {
      return zh
        ? `已按你的选择以明文保存${status.plaintext > 0 ? `（${status.plaintext} 个 provider）` : ""}。`
        : `Plaintext by your choice${status.plaintext > 0 ? ` (${status.plaintext} provider(s))` : ""}.`;
    }
    if (status.sealed > 0) {
      const base = zh
        ? `已用系统加密保存（${status.sealed} 个 provider${status.plaintext > 0 ? `，另有 ${status.plaintext} 个仍是明文` : ""}）。`
        : `Sealed with OS encryption (${status.sealed} provider(s)).`;
      const warn =
        status.unreadable > 0
          ? zh
            ? `其中 ${status.unreadable} 个**本账户解不开**（密文已保留）——请重新填写这些 API Key。`
            : ` ${status.unreadable} of them cannot be decrypted by this account.`
          : "";
      return base + warn;
    }
    if (status.backend === false) {
      return zh
        ? "这台机器没有可用的系统加密（DPAPI），密钥只能以明文保存。"
        : "No OS encryption (DPAPI) available on this machine; keys can only be plaintext.";
    }
    if (status.plaintext > 0) {
      return zh
        ? `${status.plaintext} 个 provider 的密钥仍是明文（启动时没能加密，下次启动会重试）。`
        : `${status.plaintext} provider(s) still plaintext.`;
    }
    return zh ? "当前没有已保存的密钥。" : "No saved keys.";
  })();

  return (
    <div className="setting-group">
      <label className="sp-row sp-row--gap-sm">{zh ? "API 密钥存储" : "API Key Storage"}</label>
      <div className="sp-hint sp-hint--lead">
        {zh
          ? "默认用 Windows 系统加密（DPAPI，只有当前 Windows 账户能解开）保存 API 密钥；这里可以退回明文保存。"
          : "By default API keys are protected with Windows DPAPI (only the current Windows account can decrypt). You can fall back to plaintext here."}
      </div>
      <label className="sp-check">
        <input
          type="checkbox"
          checked={status.plaintextByChoice}
          disabled={busy}
          aria-label={zh ? "以明文保存 API 密钥" : "Store API keys as plaintext"}
          onChange={(e) => void onToggle(e.target.checked)}
          className="icon-md"
        />
        <span>{zh ? "以明文保存 API 密钥（不使用系统加密）" : "Store API keys as plaintext (no OS encryption)"}</span>
      </label>
      <div className="sp-hint sp-hint--indent" role="status" aria-live="polite">
        {statusText}
      </div>
      {note && (
        <div className="sp-hint sp-hint--indent" role="status" aria-live="polite">
          {note}
        </div>
      )}
    </div>
  );
}
