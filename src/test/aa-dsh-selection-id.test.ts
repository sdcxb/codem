/**
 * 阶段 R3 判据 —— 复刻的「选择标识」层：R3-1..R3-9。
 *
 * ## 这一层为什么值得单独一套判据
 *
 * 它们的 **DSH 运行时不用通用的 `sel_*` 方案**，而是 `dsh:model:` / `dsh:permission:`。
 * 搞错的结果**不会报错** —— 只会表现为"用户选了模型但设备不认"，
 * 或者更糟：**同一个选择有两个不同 id，于是被当成两个**。
 *
 * 所以这里两侧都钉：
 * - **编码**要与它逐字一致（基准值由独立实现算出）
 * - **解码**要严格到能挡住非规范写法（否则"两个 id 指同一个东西"就成立了）
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | R3-1 | model id 与它的实现逐字一致（含中文分量、null effort） |
 * | R3-2 | permission id 逐字一致 |
 * | R3-3 | 解码后重编码必须逐字相等（挡非规范 base64） |
 * | R3-4 | 空/非法分量必须拒绝（它那边是 raise） |
 * | R3-5 | **`custom` 权限档不可远端切换**，空白/CRLF 也要拒 |
 * | R3-6 | `parseSelections` 只认 model/permission，且值必须能解出来 |
 * | R3-7 | base64url 编解码互为逆，且严格（填充/非法字符/非零位都拒） |
 * | R3-8 | 与 Rust 侧实现一致（两侧同一套语义，否则一端认另一端不认） |
 * | R3-9 | 目录构造必须用 `dsh:` id（不是 `sel_*`）—— 这条钉的是"别走错方案" |
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  modelSelectionId,
  permissionSelectionId,
  decodeModelSelection,
  decodePermissionSelection,
  parseSelections,
  base64url,
  base64urlDecode,
} from "../core/phone-link/dsh-selection-id";
import { protocolSelectionId, canonicalJson, sha256 } from "../core/phone-link/aa-protocol-ids";

const read = (p: string) => readFileSync(p, "utf8");

describe("阶段 R3 · DSH 选择标识", () => {
  it("R3-1: 模型 id 与它的实现逐字一致", () => {
    // 基准值由独立实现（Node，按 selections.ts 的语义）算出
    expect(modelSelectionId({ provider: "anthropic", model: "claude-3" })).toBe(
      "dsh:model:WyJhbnRocm9waWMiLCJjbGF1ZGUtMyIsbnVsbF0",
    );
    expect(
      modelSelectionId({ provider: "mimo", model: "mimo-v2.5-pro", reasoningEffort: "high" }),
    ).toBe("dsh:model:WyJtaW1vIiwibWltby12Mi41LXBybyIsImhpZ2giXQ");
    // 中文分量（Buffer.from/TextEncoder 都是 UTF-8 ⇒ 与它一致）
    const s = modelSelectionId({ provider: "厂商", model: "模型", reasoningEffort: "高" });
    expect(decodeModelSelection(s)).toEqual({
      provider: "厂商",
      model: "模型",
      reasoningEffort: "高",
    });
    // 没有 effort 时载荷里是 **null**（不是省略、不是空串）
    const noEffort = modelSelectionId({ provider: "p", model: "m" });
    expect(base64urlDecode(noEffort.slice("dsh:model:".length))).toBeDefined();
    expect(new TextDecoder().decode(base64urlDecode(noEffort.slice("dsh:model:".length)))).toBe(
      '["p","m",null]',
    );
    // effort 为 undefined 与显式 undefined 等价；但空串是**非法**（它那边 raise）
    expect(() => modelSelectionId({ provider: "p", model: "m", reasoningEffort: "" })).not.toThrow();
  });

  it("R3-2: permission id 逐字一致", () => {
    expect(permissionSelectionId("ask")).toBe("dsh:permission:YXNr");
    expect(permissionSelectionId("acceptEdits")).toBe("dsh:permission:YWNjZXB0RWRpdHM");
    expect(permissionSelectionId("请求批准")).toBe("dsh:permission:6K-35rGC5om55YeG");
    for (const p of ["ask", "auto", "full", "请求批准"]) {
      expect(decodePermissionSelection(permissionSelectionId(p))).toBe(p);
    }
  });

  it("R3-3: 解码后重编码必须逐字相等（挡非规范 base64）", () => {
    const id = permissionSelectionId("ask");
    expect(decodePermissionSelection(id)).toBe("ask");
    // 加填充 ⇒ 非规范
    expect(() => decodePermissionSelection(id + "=")).toThrow();
    // 前缀不对
    expect(() => decodePermissionSelection("sel_model_xyz")).toThrow();
    expect(() => decodePermissionSelection(modelSelectionId({ provider: "a", model: "b" }))).toThrow();
    // 内容像但前缀缺
    expect(() => decodePermissionSelection("YXNr")).toThrow();
    /**
     * 非规范编码的**真实**例子：长度不是 4 的倍数 ⇒ 末尾有剩余位。
     *
     * `permissionSelectionId("f")` 的载荷是 `Zg`（2 字符 = 1 字节 + 4 个剩余位）。
     * 把那 4 位改成非零（`Zh`）就是**非规范**编码 —— 必须拒。
     *
     * ⚠️ 我第一版拿"把 4 字符整组的末位改掉"当非规范例子，**那是错的**：
     * 整组 4 字符刚好解出 3 字节，改末位只是解出**另一段合法文本**
     * （`YXNs` = "asl"，仍是规范编码）⇒ 判据红得对，是我的假设错了。
     * 换句话说：只有**带剩余位**的编码才存在"非规范"这回事。
     */
    const oneByte = permissionSelectionId("f");
    const body = oneByte.slice("dsh:permission:".length);
    expect(body, "1 字节的载荷应当是 2 个字符").toBe("Zg");
    expect(decodePermissionSelection(oneByte)).toBe("f");
    expect(() => decodePermissionSelection("dsh:permission:Zh")).toThrow();
    expect(() => decodePermissionSelection("dsh:permission:Zg=")).toThrow();
    /**
     * 规范性复核真正不可替代的那一类：**载荷不是合法 UTF-8**。
     *
     * `_w` 是字节 `0xFF` 的**规范**编码（剩余位为 0），所以解码器与字符集校验
     * 都拦不住它；但 `TextDecoder` 会把非法字节换成 `U+FFFD`，
     * 再编码就变成 `77-9` ≠ `_w` —— **只有重编码复核能发现这件事**。
     *
     * 少了这一步的后果是具体的：一个"权限档名"会变成 `"\uFFFD"` 并被**接受**。
     * 变异自证正是这么发现我漏了这条判据的（去掉复核时判据全绿）。
     */
    expect(base64urlDecode("_w")).toEqual(new Uint8Array([0xff]));
    expect(() => decodePermissionSelection("dsh:permission:_w")).toThrow();
    expect(() =>
      decodeModelSelection(
        "dsh:model:" + base64url(new Uint8Array([0x5b, 0xff, 0x5d])), // "[<invalid>]"
      ),
    ).toThrow();
  });

  it("R3-4: 空/非法分量必须拒绝", () => {
    const mk = (arr: unknown) =>
      "dsh:model:" + base64url(new TextEncoder().encode(JSON.stringify(arr)));
    expect(() => decodeModelSelection(mk(["", "b", null]))).toThrow();
    expect(() => decodeModelSelection(mk(["a", "", null]))).toThrow();
    expect(() => decodeModelSelection(mk(["a", "b", ""]))).toThrow();
    expect(() => decodeModelSelection(mk(["a", "b"]))).toThrow();       // 只有两个
    expect(() => decodeModelSelection(mk(["a", "b", "c", "d"]))).toThrow(); // 四个
    expect(() => decodeModelSelection(mk({ provider: "a" }))).toThrow();     // 不是数组
    expect(() => decodeModelSelection(mk(["a", "b", 3]))).toThrow();         // 类型错
    // 非 JSON
    expect(() =>
      decodeModelSelection("dsh:model:" + base64url(new TextEncoder().encode("hello"))),
    ).toThrow();
  });

  it("R3-5: `custom` 权限档**不可远端切换**，空白与 CRLF 也要拒", () => {
    /**
     * 这条最要紧：`custom` 是"用户自定义的一整套权限"，
     * 远端把它当成一个可选档套用 = 绕过用户的定制。
     */
    expect(() => decodePermissionSelection(permissionSelectionId("custom"))).toThrow();
    expect(() => decodePermissionSelection(permissionSelectionId(""))).toThrow();
    expect(() => decodePermissionSelection(permissionSelectionId(" ask"))).toThrow();
    expect(() => decodePermissionSelection(permissionSelectionId("ask "))).toThrow();
    expect(() => decodePermissionSelection(permissionSelectionId("a\nb"))).toThrow();
    expect(() => decodePermissionSelection(permissionSelectionId("a\rb"))).toThrow();
    // 正常档位仍然可用
    expect(decodePermissionSelection(permissionSelectionId("auto"))).toBe("auto");
  });

  it("R3-6: parseSelections 只认 model/permission，且值必须能解出来", () => {
    const m = modelSelectionId({ provider: "p", model: "m" });
    const perm = permissionSelectionId("ask");
    expect(parseSelections({ model: m, permission: perm })).toEqual({ model: m, permission: perm });
    // undefined ⇒ 空对象（不是报错）
    expect(parseSelections(undefined)).toEqual({});
    // 不认识的作用域。
    // ⚠️ 值必须用**对该作用域本身合法**的那个 id —— 否则"报错"可能只是
    // 因为值解得不对，而不是因为作用域被校验了（第一版就是这么被绕过的：
    // 变异去掉作用域校验后判据照样绿）。
    expect(() => parseSelections({ effort: m })).toThrow();
    expect(() => parseSelections({ effort: perm })).toThrow();
    expect(() => parseSelections({ reasoning: m })).toThrow();
    // 值不是字符串 / 空串
    expect(() => parseSelections({ model: 3 })).toThrow();
    expect(() => parseSelections({ model: "" })).toThrow();
    // 值必须**真的解得出来**（不做"先存下以后再校验"）
    expect(() => parseSelections({ model: "随便一个字符串" })).toThrow();
    expect(() => parseSelections({ permission: permissionSelectionId("custom") })).toThrow();
    // 不是对象
    expect(() => parseSelections([])).toThrow();
    expect(() => parseSelections("x")).toThrow();
  });

  it("R3-7: base64url 编解码互为逆，且严格", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar", "请求批准", "dsh"]) {
      const enc = base64url(new TextEncoder().encode(s));
      expect(new TextDecoder().decode(base64urlDecode(enc))).toBe(s);
    }
    expect(() => base64urlDecode("a+b")).toThrow();
    expect(() => base64urlDecode("a/b")).toThrow();
    expect(() => base64urlDecode("a=")).toThrow();
    // "Zg" = "f" 合法；"Zh" 的最后 4 位非零 ⇒ 非规范
    expect(new TextDecoder().decode(base64urlDecode("Zg"))).toBe("f");
    expect(() => base64urlDecode("Zh")).toThrow();
  });

  it("R3-9: 目录必须用 `dsh:` id，**不是** `sel_*`（别走错方案）", () => {
    const id = modelSelectionId({ provider: "p", model: "m" });
    expect(id.startsWith("dsh:model:")).toBe(true);
    // 通用方案产出的是另一种形状 —— 两者**必须不同**，否则说明我们用错了方案
    const generic = protocolSelectionId("dsh", "model", { model_id: "m", reasoning_id: null });
    expect(generic.startsWith("sel_model_")).toBe(true);
    expect(id).not.toBe(generic);
    // 而且通用方案的输出**解不出来**（前缀就不对）
    expect(() => decodeModelSelection(generic)).toThrow();
  });

  it("R3-8: 与 Rust 侧实现一致（同一套语义，否则一端认另一端不认）", () => {
    /**
     * 两侧各有一份实现（TS 是"插件侧"、Rust 是 connector 侧）。
     * 它们必须产出**逐字相同**的 id，否则就是一个经典的"半边能跑"缺陷：
     * 一端发出去的 id 另一端解不出来，而表现只是"选择不生效"。
     *
     * 这里用**已知基准值**同时钉住两侧（Rust 侧的同一组基准值在
     * `aa_dsh_identity.rs` 的测试里），任一侧改动都会被这里或那里抓到。
     */
    const cases: Array<[string, string]> = [
      ["dsh:model:WyJhbnRocm9waWMiLCJjbGF1ZGUtMyIsbnVsbF0", "anthropic|claude-3|"],
      ["dsh:model:WyJtaW1vIiwibWltby12Mi41LXBybyIsImhpZ2giXQ", "mimo|mimo-v2.5-pro|high"],
      ["dsh:permission:YXNr", "ask"],
      ["dsh:permission:6K-35rGC5om55YeG", "请求批准"],
    ];
    expect(
      modelSelectionId({ provider: "anthropic", model: "claude-3" }),
    ).toBe(cases[0][0]);
    expect(
      modelSelectionId({ provider: "mimo", model: "mimo-v2.5-pro", reasoningEffort: "high" }),
    ).toBe(cases[1][0]);
    expect(permissionSelectionId("ask")).toBe(cases[2][0]);
    expect(permissionSelectionId("请求批准")).toBe(cases[3][0]);

    // SHA-256 用公开测试向量钉住（自己实现的东西必须被钉）
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const te = new TextEncoder();
    expect(hex(sha256(te.encode("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(te.encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // 跨块边界（>64 字节）
    expect(hex(sha256(te.encode("a".repeat(1000))))).toHaveLength(64);

    // 通用方案与 Rust 侧的基准值一致（同一个 Node 算出的值）
    expect(protocolSelectionId("dsh", "model", { id: "mimo-v2.5-pro" })).toBe(
      "sel_model_a3a9N1XurexwY5RDxgh1LmaH",
    );
    expect(
      protocolSelectionId("dsh", "permission", { id: "ask", label: "请求批准", meta: { b: 1, a: 2 } }),
    ).toBe("sel_permission_DsXUiUHt1Zvn00gArSu87PIR");
    expect(protocolSelectionId("dsh", "model", {})).toBe("sel_model_mXP3Gbn7dtW7WNxHi3sqGVBy");

    // canonicalJson：键递归排序、紧凑、非 ASCII 原样
    expect(canonicalJson({ b: 1, a: { z: 2, y: 3 }, c: "甲" })).toBe(
      '{"a":{"y":3,"z":2},"b":1,"c":"甲"}',
    );
    expect(canonicalJson([1, "甲", null])).toBe('[1,"甲",null]');
  });
});
