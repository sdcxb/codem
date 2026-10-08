/**
 * **脱敏不许破坏正常内容**（第 187 波 R4）—— 记忆路径的**反向判据**。
 *
 * ## 现场（本仓付过代价的那条老事故）
 *
 * `src/core/utils/redact.ts` 的 API key 形状正则原来是
 * `/(?:sk|pk|key|api[_-]?key)[-_]?[a-zA-Z0-9]{20,}/gi` —— 与第 49 波在
 * `credential-census` 里修掉的**同一形态的两个口子**：
 *   ① **没有前边界** ⇒ `ri`+`sk-…`（risk id）、`ta`+`sk-…`（task id）里的 `sk-` 也算密钥；
 *   ② **正文允许 `-`/`_`** ⇒ 路径/ID 里的分隔符让"凑满 20 字符"轻而易举。
 * 第 49 波只改了**另一份**形状判据（`CREDENTIAL_VALUE_RES`），`redact.ts` 一字未动。
 *
 * 本波把 `redactSecrets` **新接到**记忆的手动写入/编辑/导入路径
 * （`memory.ts` 的 `createEntry` / `update` / `importFromJSON`）⇒ 上面那两个口子
 * 会让**用户手写的记忆正文被不可逆改写并落库**（记忆是长期知识，原样不可恢复）。
 *
 * ## 判据（含**反向对照**：证明这类内容确实会被旧形状打中，否则可能是测空气）
 *
 * | 判据 | 断言 | 变异（把前边界改回旧写法） |
 * | --- | --- | --- |
 * | `REDACT-1` | `task-sk-…` / `risk-sk-…` 路径片段在 `add` 之后**逐字不变**（含落库后重载） | 红 |
 * | `REDACT-2` | 真令牌（`sk-…` / `pk-…` / `api_key-…`）**仍然被脱敏**（能力没被改瞎） | 绿（不受影响） |
 * | `REDACT-3` | `update` / `importFromJSON` 两条入口同样不改写路径片段 | 红 |
 *
 * ## 第 188 波（R3）：上一版的两条判据都在**空转**，这里补齐两个方向
 *
 * 上一版的 `REAL_TOKENS` 只有「小写 + 无连字符 + 恰好 20 位以上字母数字」三条，
 * 而第 187 波那版正则（丢了 `i`、尾部边界排除 `-`/`_`）**恰好**只命中这一种形态 ⇒
 * "能力没被改瞎"这条断言是**假的**（`SK-…`、`Key-…`、`sk-proj-…`、`sk-ant-api03-…`、
 * `sk-…-x` 全都不命中，实测）。误伤那一侧同样只覆盖了 `task-sk-…`，而
 * `C:\work\key-…\src`、`feat/key-…` 里的段首 `key-` 仍被整段改写。
 *
 * 所以现在的判据是**两张表、逐条断言**：
 * - `REDACT-TOKENS`：真实令牌表（含大写、`sk-proj-…`、`sk-ant-api03-…`、`sk-…-x`、
 *   `sk-…_extra`、`foo=sk-…`、引号内、行首、跟在中文后）⇒ **每一条都必须被脱敏**；
 * - `REDACT-PATHS`：误伤表（`task-sk-…`、`risk-sk-…`、`C:\work\key-…\src`、
 *   `feat/key-…`、`src/api_key/…`）⇒ **逐字不变**，且每条都先用旧形状证明"它确实在打击面内"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { loadMemory, saveMemory } from "../core/storage/settings";
import { MemoryService } from "../core/memory/memory";
import { redactSecrets } from "../core/utils/redact";

/** 旧形状（**仅供反例对照**：证明"这类内容会被它打中"，不是要用的判据） */
const OLD_SHAPE = /(?:sk|pk|key|api[_-]?key)[-_]?[a-zA-Z0-9]{20,}/gi;

/** 第 187 波那版形状（丢了 `i` + 尾部边界排除 `-`/`_`）—— 同作反例对照，见文件头 */
const PREV_SHAPE = /(?<![A-Za-z0-9_-])(?:sk|pk|key|api[_-]?key)[-_]?[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/g;

/** 路径 / ID 片段：`sk-` 前面是 `-`（task-）或字母（ri**sk**-） */
const PATH_LIKE = [
  "C:\\work\\task-sk-9f8e7d6c5b4a3210012345\\src\\index.ts",
  "符号 risk-sk-abcdefghij1234567890 出现在日志里",
  "分支 feat/key-abcdefghij1234567890-merge 已合并",
];
const REAL_TOKENS = [
  "sk-abcdefghijklmnopqrstuvwxyz012345",
  "pk-abcdefghijklmnopqrstuvwxyz012345",
  "api_key-abcdefghijklmnopqrstuvwxyz01",
];

/**
 * `REDACT-PATHS`（第 188 波 R3 补）：**误伤表** —— 逐条必须逐字不变。
 *
 * `oldShapeHit` 是**反例对照的期望值**（而不是一句"旧形状必须打中"的免责声明）：
 * - `true` ⇒ 第 187 波之前那份形状**必须**打中它（证明这条样本真在打击面内，
 *   否则它只是在测空气 —— 上一版第三条就是靠尾巴上的 `-merge` 被蒙对的）；
 * - `false` ⇒ 两份旧形状**都**打不中它，而**本轮新写的**弱前缀规则仍必须放过它
 *   （少了路径守卫就会被改写），所以它是新规则的真实边界样本。
 */
const MISREDACT_PATHS: Array<{ text: string; oldShapeHit: boolean; why: string }> = [
  // ① 段内 `sk-`：前面是 `-`（task-）/ 字母（ri**sk**-）—— 第 187 波已修，这里守回归
  { text: "C:\\work\\task-sk-9f8e7d6c5b4a3210012345\\src\\index.ts", oldShapeHit: true, why: "task- 里的 sk-" },
  { text: "risk-sk-abcdefghij1234567890 是风险 id", oldShapeHit: true, why: "risk 里的 sk-" },
  // ② **段首** `key-`：第 187 波**没修**的那一类（路径段与密钥同形，形状规则分不开）
  { text: "C:\\work\\key-abcdefghij1234567890\\src", oldShapeHit: true, why: "段首 key-" },
  { text: "feat/key-abcdefghij1234567890", oldShapeHit: true, why: "分支名里的 key-" },
  { text: "分支 feat/key-abcdefghij1234567890-merge 已合并", oldShapeHit: true, why: "上一版靠尾巴 -merge 蒙对" },
  // ③ 路径段里的 `api_key-…`（前面紧邻 `/` 或 `\`）：本轮弱前缀规则的路径守卫在这里生效
  { text: "C:\\work\\api_key-abcdefghij1234567890\\src\\index.ts", oldShapeHit: true, why: "路径段 api_key-" },
  {
    text: "src/api_key-handler-abcdefghij1234567890",
    oldShapeHit: false,
    why: "handler- 的分隔符让两份旧形状自己也失准（本仓那条老形态），但新规则仍必须放过它",
  },
];

/**
 * `REDACT-TOKENS`（第 188 波 R3 补）：**真实令牌表** —— 逐条必须被脱敏。
 *
 * 覆盖上一版空转的那种样本以外的全部形态：大写、`sk-proj-…`、`sk-ant-api03-…`、
 * `sk-…-x`、`sk-…_extra`、赋值右侧、引号内、行首、跟在中文/全角后、句末标点。
 */
const REAL_TOKEN_CASES: Array<{ label: string; text: string; token: string }> = [
  { label: "小写 sk-", text: "sk-abcdefghijklmnopqrstuvwxyz012345", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "小写 pk-", text: "pk-abcdefghijklmnopqrstuvwxyz012345", token: "pk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "OpenAI project key", text: "sk-proj-abcdefghijklmnopqrstuvwxyz012345", token: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "Anthropic key", text: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz", token: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" },
  { label: "大写 SK-", text: "SK-abcdefghijklmnopqrstuvwxyz012345", token: "SK-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "混合大小写", text: "Sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345", token: "Sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345" },
  { label: "Api_Key- 写法", text: "Api_Key-abcdefghijklmnopqrstuvwxyz0123", token: "Api_Key-abcdefghijklmnopqrstuvwxyz0123" },
  { label: "OPENAI_API_KEY- 写法", text: "OPENAI_API_KEY-abcdefghijklmnopqrstuvwxyz", token: "API_KEY-abcdefghijklmnopqrstuvwxyz" },
  { label: "apikey- 写法", text: "apikey-abcdefghijklmnopqrstuvwxyz012345", token: "apikey-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "api-key- 写法", text: "api-key-abcdefghijklmnopqrstuvwxyz012345", token: "api-key-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "尾部 -x", text: "sk-abcdefghijklmnopqrstuvwxyz012345-x", token: "sk-abcdefghijklmnopqrstuvwxyz012345-x" },
  { label: "尾部 _extra", text: "sk-abcdefghijklmnopqrstuvwxyz012345_extra", token: "sk-abcdefghijklmnopqrstuvwxyz012345_extra" },
  { label: "赋值右侧", text: "foo=sk-abcdefghijklmnopqrstuvwxyz012345", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "引号内", text: '"sk-abcdefghijklmnopqrstuvwxyz012345"', token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "行首", text: "sk-abcdefghijklmnopqrstuvwxyz012345", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "中文后", text: "排查：sk-abcdefghijklmnopqrstuvwxyz012345 出现", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "全角/句末标点后", text: "（密钥）sk-abcdefghijklmnopqrstuvwxyz012345。", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
];

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
  saveMemory("");
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("REDACT：脱敏不许改写路径/ID 片段（记忆写入口的反向判据）", () => {
  it("REDACT-1（含反例对照）：路径片段在 add 之后逐字不变，真令牌仍被脱敏", () => {
    // 反例对照：旧形状确实会命中这些路径片段（否则本判据的对象不存在）
    for (const p of PATH_LIKE) {
      expect((p.match(OLD_SHAPE) ?? []).length, `旧形状必须真的会打中（否则判据是测空气）：${p}`).toBeGreaterThan(0);
      expect(redactSecrets(p), `新形状必须逐字保留：${p}`).toBe(p);
    }

    const svc = new MemoryService();
    for (const [i, p] of PATH_LIKE.entries()) {
      const added = svc.add({ scope: "platform", key: `路径 ${i}`, content: p, source: "manual" });
      expect(added.ok).toBe(true);
      expect(added.entry!.content, `记忆内容被改写了（不可逆）：${p}`).toBe(p);
    }
    svc.add({ scope: "platform", key: "路径 9 的笔记", content: PATH_LIKE[0], source: "manual" });
    saveMemory(JSON.stringify({ version: 2, entries: Object.fromEntries(svc.listAll().map((e) => [e.id, e])) }));

    // 落库后重新加载：仍然逐字一致
    const reloaded = new MemoryService();
    const contents = reloaded.listAll().map((e) => e.content);
    for (const p of PATH_LIKE) expect(contents, "重载后路径片段必须逐字还在").toContain(p);

    // 真令牌照旧被脱敏（不许为了消误报把能力改瞎）
    for (const token of REAL_TOKENS) {
      const safe = redactSecrets(`排查：${token} 出现在错误里`);
      expect(safe, `真令牌必须被脱敏：${token}`).not.toContain(token);
      expect(safe).toContain("[REDACTED_API_KEY]");
      expect((`排查：${token} 出现在错误里`).match(OLD_SHAPE)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("REDACT-3：update 与 importFromJSON 两条入口同样不改写路径片段", () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "platform", key: "待改", content: "PLACEHOLDER", source: "manual" });

    expect(svc.update(added.entry!.id, { content: PATH_LIKE[0] }, { actor: "user" })).toBe(true);
    expect(svc.get(added.entry!.id)!.content, "编辑路径也不许改写内容").toBe(PATH_LIKE[0]);

    const imported = svc.importFromJSON(
      JSON.stringify({
        version: 2,
        entries: {
          "imp-1": { id: "imp-1", scope: "platform", key: "导入的路径", content: PATH_LIKE[1], timestamp: 1, source: "manual", status: "active" },
        },
      }),
      false,
    );
    expect(imported.imported).toBe(1);
    expect(svc.get("imp-1")!.content, "导入路径也不许改写内容").toBe(PATH_LIKE[1]);

    // 而真令牌在导入时照旧被脱敏
    const imported2 = svc.importFromJSON(
      JSON.stringify({
        version: 2,
        entries: {
          "imp-2": { id: "imp-2", scope: "platform", key: "导入的密钥", content: `key: ${REAL_TOKENS[0]}`, timestamp: 2, source: "manual", status: "active" },
        },
      }),
      false,
    );
    expect(imported2.imported).toBe(1);
    expect(svc.get("imp-2")!.content, "真令牌必须在导入时被脱敏").not.toContain(REAL_TOKENS[0]);

    // 落库内容同样是安全的（不泄漏明文令牌）
    expect(loadMemory()).not.toContain(REAL_TOKENS[0]);
  });

  /**
   * `REDACT-TOKENS`（第 188 波 R3）：真实令牌表**逐条**必须被脱敏 —— 两个方向都要证。
   *
   * 变异：把 `redact.ts` 那份正则的 `i` 标志去掉 ⇒ 本条在 `SK-…` / `Api_Key-…` /
   * `OPENAI_API_KEY-…` 三条上红（上一版就是这么漏的）。
   */
  it("REDACT-TOKENS：真实令牌表逐条被脱敏（含大写 / sk-proj- / sk-ant- / 尾部 -_ / 中文后）", () => {
    for (const { label, text, token } of REAL_TOKEN_CASES) {
      const safe = redactSecrets(text);
      expect(safe, `[${label}] 必须被脱敏，实际：${safe}`).not.toContain(token);
      expect(safe, `[${label}] 必须留下脱敏占位符`).toContain("[REDACTED_API_KEY]");
    }
  });

  /**
   * `REDACT-PATHS`（第 188 波 R3）：误伤表**逐条**必须逐字不变。
   *
   * 变异：把裸 `key-` 加回前缀表（第 187 波那版）⇒ 本条在三条 `key-…` 上红；
   * 把前边界改回旧写法 ⇒ 在 `task-sk-…` / `risk-sk-…` 上红。
   */
  it("REDACT-PATHS：路径/ID 片段逐条逐字不变（含段首 key-、路径段 api_key-）", () => {
    for (const { text: p, oldShapeHit, why } of MISREDACT_PATHS) {
      /*
       * 反例对照**按登记值断言**：登记 `true` 的必须真的被旧形状打中（否则这条样本
       * 只是在测空气）；登记 `false` 的必须真的打不中（那种形态连旧形状也失准）。
       * 两个方向都钉住，免得"表格里写一句注释"变成免检。
       */
      const oldHits = (p.match(OLD_SHAPE) ?? []).length > 0;
      const prevHits = (p.match(PREV_SHAPE) ?? []).length > 0;
      expect(oldHits || prevHits, `[${why}] 两版旧形状都没打中 ⇒ 它不是"误伤"样本：${p}`).toBe(oldShapeHit);
      expect(redactSecrets(p), `[${why}] 路径片段被改写了（不可逆）：${p}`).toBe(p);
    }
    // 短串本来就不该命中（长度口径，与误伤无关）—— 一并钉住，免得有人拿"放宽长度"来消误伤
    for (const short of ["sk-1", "sk-abc", "key-abc", "pk-2"])
      expect(redactSecrets(short), `短串不是令牌：${short}`).toBe(short);
  });
});
