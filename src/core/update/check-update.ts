/**
 * 「检查更新」的判定与措辞（第 62 轮；对标 `dsh-desktop` 的"清单回显校验"）。
 *
 * ## 为什么抽出来单独一个纯函数
 *
 * 界面里那段逻辑原来是**内联在按钮 onClick 里**的 40 行：拿不到更新就无条件显示
 * **「已是最新版本」**。而我们在 `docs/RELEASE-GUIDE.md` 里已经**写实**过一条真机现象：
 * **刚发布的 `latest.json` 会被 CDN 缓存住（传播延迟）**。
 * 两者叠在一起就是一个**假结论**：CDN 还在发旧清单 → `check()` 说没有更新 →
 * 界面断言"已是最新版本" →（本会话真实发生过：`git push` 与 `gh release` 都报过
 * TLS/EOF，发布链路本来就可能慢半拍）。
 *
 * 所以这里把判定做成**可测的纯函数**，并把措辞与判定绑死：
 *
 * | 情形 | 判定 | 界面必须说的话 |
 * | --- | --- | --- |
 * | 清单里给的版本**高于**本机 | `update` | 发现新版本 x.y.z，开始下载 |
 * | 清单已读到、但没有更高的版本（`check()` 返回 `null`） | `none` | 未发现更新（当前 v…）—— **不说**"已是最新"，并提一句 CDN 可能还没同步 |
 * | 清单里给的版本**等于**本机 | `none` | 未发现更新（清单里就是 v…） |
 * | 清单里给的版本**低于**本机 | `anomaly` | 清单版本比本机旧（多半是 CDN 缓存），**拒绝安装**并说明 |
 * | 版本号读不出来 | `unknown` | 清单里的版本号读不出来，已忽略（不猜） |
 *
 * ## 判定依据是插件自己的契约（不是猜的）
 *
 * `tauri-plugin-updater` 的 `Updater::check()`（`updater.rs:386`）只有在**清单真的取到并解析成功**
 * 之后才会走到版本比较，**取不到就抛错**（那个分支在界面里是 `catch`）。
 * 所以：`check()` 抛错 = **清单没读到**（网络/发布延迟，界面报错）；
 * `check()` 返回 `null` = **清单读到了，只是里面没有更高的版本** —— 这两件事必须说成两句不同的话。
 * `available` 字段在 v2 里已废弃（`dist-js/index.d.ts` 明写 "This is always true"），
 * 所以这里判"有没有更新"用 **`check()` 的返回值是否为 `null`**。
 *
 * ## 它**不**负责什么（边界如实写）
 *
 * 包的**签名校验**由 `tauri-plugin-updater` 用内置公钥完成（本函数不重复实现密码学）；
 * 这里管的是"清单回显"这一层：**版本号必须与判定一致**，不一致就不许装、不许说很新。
 */

export type UpdateDecisionKind = "update" | "none" | "anomaly" | "unknown";

export interface UpdateDecision {
  kind: UpdateDecisionKind;
  /** 清单里给出的版本（`unknown` 时为 null） */
  offered: string | null;
  /** 应当告诉用户的话（中英各一份） */
  message: { zh: string; en: string };
}

/** 把 `1.16.102` / `1.16.102-beta.1` 解析成数字三元组；解析不了返回 null（**不猜**） */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 数值比较：`a > b` → 1，相等 → 0，`a < b` → -1；任一解析不了 → null */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function decideUpdate(current: string, offered: string | null | undefined): UpdateDecision {
  if (offered === null || offered === undefined || offered === "") {
    /**
     * 走到这里说明 `check()` **没有抛错**：清单读到了，里面没有更高的版本。
     * 所以措辞是"未发现更新"，并且**明确提示 CDN 传播延迟**这一条真机现象
     * （`docs/RELEASE-GUIDE.md`），而不是断言"已是最新版本"。
     */
    return {
      kind: "none",
      offered: null,
      message: {
        zh: `未发现更新（当前 v${current}）—— 更新清单已读到，里面没有更高的版本；若刚发布，CDN 可能还没同步`,
        en: `No update found (current v${current}). The manifest was read and has no higher version; a just-published release may still be behind the CDN.`,
      },
    };
  }
  const cmp = compareVersions(offered, current);
  if (cmp === null) {
    return {
      kind: "unknown",
      offered: String(offered),
      message: {
        zh: `更新清单里的版本号读不出来（"${offered}"），已忽略（不猜）`,
        en: `Unreadable version in the manifest ("${offered}") — ignored`,
      },
    };
  }
  if (cmp > 0) {
    return {
      kind: "update",
      offered: String(offered),
      message: { zh: `发现新版本 ${offered}，下载中…`, en: `Version ${offered} found, downloading…` },
    };
  }
  if (cmp === 0) {
    return {
      kind: "none",
      offered: String(offered),
      message: {
        zh: `未发现更新（清单里的版本就是 v${offered}）`,
        en: `No update found (the manifest version is v${offered})`,
      },
    };
  }
  return {
    kind: "anomaly",
    offered: String(offered),
    message: {
      zh: `更新清单里的版本（${offered}）比本机（v${current}）旧，已拒绝安装 —— 多半是 CDN 还在发缓存里的旧清单，稍后再试`,
      en: `Manifest version (${offered}) is older than this build (v${current}); install refused (likely a stale CDN copy)`,
    },
  };
}
