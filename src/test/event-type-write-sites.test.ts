/**
 * EVENT-TYPE-WRITES —— **写事件的地方，类型名必须在权威集合里**（第 68 轮新增门禁）。
 *
 * ## 为什么要这条门禁（真机取证）
 *
 * 用户机器的控制台：
 * ```text
 * [PersistFailure] maintenance.eventStructure 操作失败：事件库结构异常 7360 处
 * （样例：1787630173686-ogk8e1sw4: Unknown event type "trajectory_step" at seq 2643；…）
 * ```
 *
 * 7360 条"未知事件类型"全部来自**我们自己写的**事件：`ui-trajectory-provider.ts` 用
 * `TRAJECTORY_EVENT_TYPE = 'trajectory_step'` 批量落库，而这个名字既不在
 * `BUILTIN_EVENT_TYPES` 里、也没人调 `registerCustomEventType`。结构自检于是把每一条真实事件
 * 都报成"不合法类型" —— 一台**假报警机器**，把真正的结构问题淹在噪声里。
 * （同类问题在 `session_snapshot` 上已经栽过一回，见 `event-types.ts` 的长注释；
 * 当时只补了那一个类型，**没有堵住"类型名可以随便写"这条路**。）
 *
 * ## 这条门禁怎么做到"只认真正的事件写入"
 *
 * 用**类型检查器**判定被调用的 `append`/`appendBatch` 到底是不是 `EventLog` 的方法
 * （声明在 `core/storage/event-log.ts`）。为什么必须用类型而不是名字：
 * 名字判据会把 `formData.append("file", blob)` 这类**完全无关**的调用算进来
 * （第一版就是这样：报了 3 条假违规，真正的 `trajectory_step` 反而因为写法是
 * `type: TRAJECTORY_EVENT_TYPE`（标识符而不是字面量）而漏掉）。
 * 所以两件事一起做：**解析到 EventLog 的调用** + **把同文件里的常量解析成字面量**。
 *
 * 只看**产品代码**（`src/**` 去掉 `src/test/**`）：测试会**故意**写非法类型来证明校验器会拒绝
 * （`replay-validation.test.ts`），算进来就成了自相矛盾。
 *
 * ⚠️ 静态能管的只有"能解析出字面量"的类型名。运行期才确定的（插件从配置里读出来的名字）
 * 由 `event-log.ts::append/appendBatch` 的写入侧守卫兜底（未注册 → 自动登记 + 如实上报）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { isValidEventType, listCustomEventTypes } from "../core/storage/event-types";
import { __resetUnknownEventTypeWarnings } from "../core/storage/event-log";
import { getEventLog } from "../core/storage/event-log";
import { getEventProjection } from "../core/storage/event-projection";
import { setStoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SID = "sess-etw";

const ROOT = join(__dirname, "..", "..");
/** 事件写入的唯一实现文件：只有"被调用方法声明在这里"才算事件写入 */
const EVENT_LOG_IMPL = "core/storage/event-log.ts";

interface Site {
  rel: string;
  line: number;
  typeName: string;
  /** 类型名是内联字面量还是同文件常量（便于排查） */
  via: string;
}

/** 同文件里的顶层常量字符串（`const TRAJECTORY_EVENT_TYPE = 'trajectory_step'`） */
function constStringTable(sf: ts.SourceFile): Map<string, string> {
  const table = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = ts.isAsExpression(decl.initializer) ? decl.initializer.expression : decl.initializer;
      if (ts.isStringLiteral(init)) table.set(decl.name.text, init.text);
    }
  }
  return table;
}

/** 同一个 Program 只建一次：`ts.createProgram` 要 2~3 秒，四个用例各建一次纯属浪费 */
let cachedProgram: ts.Program | null = null;
let cachedChecker: ts.TypeChecker | null = null;

/** 丢掉缓存（EVENT-TYPE-WRITES-3 会临时加一个文件，必须重新建 Program 才看得见） */
function resetProgramCache(): void {
  cachedProgram = null;
  cachedChecker = null;
}

function getProgram(): ts.Program {
  if (cachedProgram) return cachedProgram;
  const configPath = join(ROOT, "tsconfig.json");
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  cachedProgram = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  return cachedProgram;
}
function getChecker(): ts.TypeChecker {
  if (!cachedChecker) cachedChecker = getProgram().getTypeChecker();
  return cachedChecker;
}

function collectWriteSites(): { sites: Site[]; scannedFiles: number } {
  const program = getProgram();
  const checker = getChecker();
  const sites: Site[] = [];
  let scannedFiles = 0;
  for (const sf of program.getSourceFiles()) {
    const rel = relative(ROOT, sf.fileName).replace(/\\/g, "/");
    if (!rel.startsWith("src/") || rel.startsWith("src/test/") || /\.d\.ts$/.test(rel)) continue;
    scannedFiles++;
    const consts = constStringTable(sf);

    /** 从实参里抠出类型名（字面量 + 同文件常量） */
    const namesFrom = (node: ts.Expression): Array<{ name: string; via: string }> => {
      const out: Array<{ name: string; via: string }> = [];
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "type") {
          const init = n.initializer;
          if (ts.isStringLiteral(init)) out.push({ name: init.text, via: "字面量" });
          else if (ts.isIdentifier(init) && consts.has(init.text)) {
            out.push({ name: consts.get(init.text)!, via: `常量 ${init.text}` });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      if (ts.isStringLiteral(node)) out.push({ name: node.text, via: "字面量（第二个实参）" });
      else if (ts.isIdentifier(node) && consts.has(node.text)) {
        out.push({ name: consts.get(node.text)!, via: `常量 ${node.text}（第二个实参）` });
      }
      return out;
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "append" || method === "appendBatch") {
          // 类型判据：被调用方法必须声明在 event-log.ts 里（排除 FormData.append 这类同名调用）
          const sym = checker.getSymbolAtLocation(node.expression.name);
          const decls = sym?.declarations ?? [];
          const isEventLogCall = decls.some((d) =>
            d.getSourceFile().fileName.replace(/\\/g, "/").endsWith(EVENT_LOG_IMPL),
          );
          if (isEventLogCall) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            for (const arg of node.arguments) {
              for (const { name, via } of namesFrom(arg)) sites.push({ rel, line, typeName: name, via });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { sites, scannedFiles };
}

describe("EVENT-TYPE-WRITES 写事件时用的类型名必须在权威集合里", () => {
  it(
    "EVENT-TYPE-WRITES-1：产品代码里没有『未注册的事件类型』",
    () => {
      const { sites, scannedFiles } = collectWriteSites();
      expect(scannedFiles, "一个产品源文件都没扫到 —— 扫描器坏了，不是代码干净").toBeGreaterThan(50);
      expect(sites.length, "一个事件写入点都没找到 —— 类型判据坏了，不是没有写入点").toBeGreaterThan(5);

      const bad = sites.filter((s) => !isValidEventType(s.typeName));
      const detail = bad.map((b) => `${b.rel}:${b.line} 写入了未知类型 "${b.typeName}"（${b.via}）`);
      expect(
        bad.map((b) => b.typeName),
        `这些事件类型写进了库、却不在权威集合里 ⇒ 结构自检会把每一条真实事件都报成\n` +
          `『Unknown event type』（真机实测 7360 条假报警，把真问题淹了）：\n  - ${detail.join("\n  - ")}\n` +
          `修法：加进 src/core/storage/event-types.ts 的 BUILTIN_EVENT_TYPES（首选，与 session_snapshot 同理），\n` +
          `或在写入方插件里 registerCustomEventType()。`,
      ).toEqual([]);

      // 台账：让"这条门禁到底在看哪些类型"一眼可见（失败时不至于只能猜）
      const all = [...new Set(sites.map((s) => s.typeName))].sort();
      console.log(`[EVENT-TYPE-WRITES] 扫描 ${scannedFiles} 个产品源文件，${sites.length} 处写入点，类型名：${all.join(" / ")}`);
    },
    60_000,
  );

  it("EVENT-TYPE-WRITES-2（前提）：权威集合真的在判——随便编一个名字必须是 false", () => {
    expect(isValidEventType("__definitely_not_a_real_event_type__")).toBe(false);
    expect(isValidEventType("tool_call"), "内建类型必须通过").toBe(true);
    for (const t of listCustomEventTypes()) {
      expect(isValidEventType(t), `已注册的自定义类型 ${t} 应当通过`).toBe(true);
    }
  });

  it("EVENT-TYPE-WRITES-3（反向守卫）：门禁必须认得出『同一个文件里的常量』这种写法", () => {
    // 真机那个漏检就是这种写法：`type: TRAJECTORY_EVENT_TYPE`。
    // 这一条用一个**临时文件**验证解析能力（否则门禁会在同一个坑上再摔一次）。
    //
    // ⚠️ 超时给到 60s（与 -1 同）：这里 `resetProgramCache()` 之后要**重扫整棵产品源码树**
    // （821 个文件）。带 `--coverage` 跑时（v8 插桩让编译/解析明显变慢）这个扫描
    // 会超过默认的 5s —— 第 72 轮实测过一次 `Test timed out in 5000ms`。
    // 这是**度量开销**，不是断言放宽：树扫不完照样红（-1 里"一个写入点都没找到"那条判据还在）。
    const rel = "src/__etw_probe__.ts";
    const abs = join(ROOT, rel);
    const body = `import { getEventLog } from "./core/storage/event-log";\nconst PROBE_EVENT_TYPE = "etw_probe_bogus";\nexport function __probe(sid: string): void {\n  getEventLog().append(sid, PROBE_EVENT_TYPE, {});\n}\n`;
    require("node:fs").writeFileSync(abs, body, "utf8");
    resetProgramCache();
    try {
      const { sites } = collectWriteSites();
      const probe = sites.filter((s) => s.typeName === "etw_probe_bogus");
      expect(probe.length, "同文件常量写法必须被解析成字面量（真机的漏检点）").toBeGreaterThan(0);
      expect(probe[0].via).toContain("常量");
    } finally {
      require("node:fs").unlinkSync(abs);
    }
  }, 60_000);

  it("EVENT-TYPE-WRITES-4（反向守卫）：`formData.append(...)` 这类同名调用**不许**被当成事件写入", () => {
    // 第一版就是按方法名匹配的：报了 3 条假违规（FormData 的 file/model/response_format）。
    const { sites } = collectWriteSites();
    for (const bogus of ["response_format", "model", "file"]) {
      expect(
        sites.some((s) => s.typeName === bogus),
        `"${bogus}" 不是事件类型，它来自某个无关的 .append() 调用 —— 类型判据又退化成名字匹配了`,
      ).toBe(false);
    }
    // 反向对照：multimodal.ts 真的调用了 formData.append，只是不该被算成事件写入
    const multimodal = readFileSync(join(ROOT, "src/core/llm/multimodal.ts"), "utf8");
    expect(multimodal.includes("formData.append("), "对照前提：该文件里确实有同名调用").toBe(true);
  });
});

/* ────────────────────────── 运行期一侧（写入守卫 + 结构自检） ────────────────────────── */

function installTauriStub(): void {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        if (cmd === "read_text_window") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

function installPort(): FakeStoragePort {
  const port = createFakeStoragePort({
    seed: {
      sessions: [{ id: SID, project_id: "", title: "etw", created_at: 0, last_message_at: 0, message_count: 0 }],
    },
  });
  setStoragePort(port);
  port.events.ensureLoaded(SID);
  return port;
}

describe("EVENT-TYPE-WRITES 运行期：写入守卫与结构自检", () => {
  beforeEach(() => {
    installTauriStub();
    resetPersistFailures();
    __resetUnknownEventTypeWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setStoragePort(null);
    delete (window as any).__TAURI__;
    vi.restoreAllMocks();
  });

  /**
   * 真机那个 7360：`trajectory_step` / `loop_stopped` 是**我们自己一直在写**的类型。
   * 修法是把它们放进权威集合 ⇒ 结构自检不再把真实事件报成非法类型。
   */
  it("EVENT-TYPE-WRITES-5: 轨迹与循环停止事件不再被结构自检报成『未知类型』（真机 7360 → 0）", () => {
    installPort();
    const log = getEventLog();
    log.append(SID, "session_meta", { preset: "standard" });
    log.append(SID, "trajectory_step", { step: { type: "llm_call", timestamp: 1, data: {} } });
    log.append(SID, "trajectory_step", { step: { type: "tool_call", timestamp: 2, data: {} } });
    log.append(SID, "loop_stopped", { reason: "done" });

    const errs = getEventProjection().validateReplay(SID);
    expect(
      errs.filter((e) => e.includes("Unknown event type")),
      `这两个类型是我们自己写的，一个都不该被报成未知类型（真机 7360 条假报警的来源）`,
    ).toEqual([]);
  });

  it("EVENT-TYPE-WRITES-6: 野类型照样被自检报出来（守卫**不会**把判据抹平）", () => {
    installPort();
    getEventLog().append(SID, "totally_bogus_type_zz", { x: 1 });
    const errs = getEventProjection().validateReplay(SID);
    expect(
      errs.filter((e) => e.includes("Unknown event type")),
      "写入守卫只上报、**不自动登记** —— 否则『凡是被写过的都合法』，结构自检再也检不出漂移",
    ).toHaveLength(1);
  });

  it("EVENT-TYPE-WRITES-7: 写野类型时在**源头**如实上报一次（同一名字不刷屏），事件不丢", () => {
    const port = installPort();
    const log = getEventLog();
    const first = log.append(SID, "wild_type_probe", { a: 1 });
    log.append(SID, "wild_type_probe", { a: 2 });
    log.appendBatch(SID, [
      { type: "wild_type_probe", payload: { a: 3 } },
      { type: "wild_type_batch_probe", payload: { b: 1 } },
    ]);

    const reports = getPersistFailures().filter((f) => f.area.startsWith("eventLog.unknownType"));
    expect(reports, "两种野类型各报一次（area 里带类型名，否则第二个名字会被去重吃掉）").toHaveLength(2);
    expect(reports.every((r) => r.count === 1), "同一个名字只报一次（热路径不刷屏）").toBe(true);
    expect(
      reports.map((r) => r.area).sort(),
      "两条上报必须分别指名道姓",
    ).toEqual(["eventLog.unknownType.wild_type_batch_probe", "eventLog.unknownType.wild_type_probe"]);
    expect(first.seq, "事件必须照样写入（不因为类型名没登记就丢数据）").toBeGreaterThan(0);
    expect(port.events.readAll(SID).some((e) => e.type === "wild_type_probe")).toBe(true);
  });

  /**
   * 真机原文（第 68 轮第一次抓到）：
   * ```text
   * [PersistFailure] maintenance.eventStructure 操作失败（第 1 次）：事件库结构异常 7360 处（…）
   *   —— 该功能本次没有生效。
   * ```
   * 后半句是假话：自检**跑成了**，那是它报出来的结果。用户读到之后会以为"自检没运行"，
   * 从此不再相信这个数字 —— 而事件是唯一没有等价物的存储，它的自检恰恰最该可信。
   *
   * ⚠️ 第 88 轮：这个站点**整条搬进了 advisory 通道**（发现类不该借失败语气）——
   * 所以控制台那行现在是 `[Advisory] …`（**warn**），不再是 `[PersistFailure] …`（error）。
   * 判据跟着变强：不只是"那句话不许出现"，而是**两类通道各归各位**。
   */
  it("EVENT-TYPE-WRITES-8: 结构异常是「发现」而不是「失败」（控制台走 [Advisory]，不许出现失败语气）", async () => {
    const port = installPort();
    port.messages.ensureLoaded(SID);
    // 直接入库一个**老版本留下的**未知类型（绕过写入守卫，模拟历史数据）
    port.events.appendLocal(SID, "legacy_unknown_type_from_old_build", "{}", 1);

    const captured: Array<Record<string, unknown>> = [];
    const on = (e: Event) => captured.push((e as CustomEvent).detail as Record<string, unknown>);
    window.addEventListener("codem:persist-failed", on);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
      await runDatabaseMaintenance();
    } finally {
      window.removeEventListener("codem:persist-failed", on);
    }

    const evt = captured.find((e) => e.area === "maintenance.eventStructure");
    expect(evt, "结构自检发现异常必须上报到界面通道").toBeTruthy();
    const { composePersistAlertText } = await import("../core/storage/persist-failure");
    const text = composePersistAlertText(evt as never);
    expect(text, "开头那句必须是真的：这是自检报出的发现，不是『操作没有生效』").not.toContain("操作没有生效");
    expect(text).toContain("结构异常");
    // 第 88 轮新增判据：发现类文案里不该出现失败语气
    for (const bad of ["请重试", "该功能本次不可用", "重启应用后会丢失"]) {
      expect(text, `发现类文案里出现了失败语气「${bad}」：${text}`).not.toContain(bad);
    }

    const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errorText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnText, "控制台那句同样是用户会读到的（真机原文就是它）").toContain("事件库结构异常");
    expect(warnText, "发现类必须标 [Advisory]").toContain("[Advisory]");
    expect(errorText, "发现类不该以 error 级别出现（会被当成「坏了」）").not.toContain("事件库结构异常");
    for (const bad of ["该功能本次没有生效", "写盘失败", "操作失败"]) {
      expect(warnText + errorText, `控制台不许出现「${bad}」—— 自检跑成了，报的是存量异常`).not.toContain(bad);
    }
  });
});
