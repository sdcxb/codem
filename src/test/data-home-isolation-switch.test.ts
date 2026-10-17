/**
 * 第 230 波 · **隔离数据根**（`CODEM_DATA_HOME`）的静态契约。
 *
 * ## 被守的东西
 *
 * 记忆面板的取证需要一个**能随便写坏、用完能整个删掉**的数据根。原来唯一的手段是
 * `CODEM_DB_PATH`，但它只挪**库文件**：库在副本目录，而运行日志 / 崩溃标记 / 数据目录台账 /
 * 功能目录（`.codem/skills`、`workspace/`、`extensions/…`）仍写在 `%APPDATA%\com.codem.app`
 * —— 第 229 波真机上正是这么发生的（`data-home.json` 的代次被顶掉一代，
 * 而那次启动自以为是"隔离钻取"）。
 *
 * 本轮加的 `CODEM_DATA_HOME` 只有一个要求：**整根跟着走**。而"整根"这件事靠人工逐个改调用点
 * 维持不住（本仓为"同一件事两处口径"付过很多次代价），所以这一族判据守的是**结构性不变量**：
 *
 * 1. `CODEM_DATA_HOME` 全仓**只有一个读取点**（`storage::isolated_data_home()`）；
 * 2. `app_data_dir()` 全仓**只剩一个调用点**（`lib.rs::app_data_dir_path`）——
 *    任何人新加一处 `app.path().app_data_dir()`，隔离就漏一个口子，判据立刻红；
 * 3. 日志目录、崩溃标记、panic 现场、插件目录、手机/iLink 目录**都**走那个唯一入口；
 * 4. `ensure_isolated_root` 的"必需目录"表**与 TS 侧真的用的目录名逐条对得上**
 *    （不是抄一份写在注释里 —— 抄的那份会腐烂）。
 *
 * ## 为什么静态判据在这里是必要的补充（不是替代行为判据）
 *
 * "默认路径不变"与"设了就整根走"由 Rust 单测（`storage::tests::ISO-1…3`）与真机取证守；
 * 但"**将来新加的**一处 `app_data_dir()`"只有读源码能提前拦住（行为判据要等那条路径真的被走到）。
 * 两类判据一起才完整 —— 变异自证见 `.preview-shot/_mutate-230-iso.mjs`。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const RUST = path.join(ROOT, "src-tauri", "src");

function read(rel: string): string {
  /*
   * ⚠️ Rust 与 TS 源文件在本仓都是 CRLF 行尾：这里统一成 LF 再断言 ——
   * 否则 `indexOf("\n}\n")` 这类"找函数结尾"的写法会永远找不到（第一次就是这么栽的）。
   * 归一化只影响**判据内部的比较**，不改任何文件。
   */
  const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (!/\r\n/.test(raw) && !/\r/.test(raw)) return raw;
  return raw.replace(/\r\n/g, "\n");
}

const storageRs = read("src-tauri/src/storage.rs");
const libRs = read("src-tauri/src/lib.rs");
const runtimeLogRs = read("src-tauri/src/runtime_log.rs");

/** 数一段文本里某个子串出现几次（判据自己也要能被读，所以不用正则转义的小把戏） */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** 取一个 Rust 函数体（从 `签名` 到下一个顶层 `}` 后换行）—— 只为把断言限定在这个函数里 */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `找不到函数：${signature}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const end = rest.indexOf("\n}\n");
  expect(end, `找不到函数结尾：${signature}`).toBeGreaterThan(0);
  return rest.slice(0, end + 3);
}

describe("ISO-STATIC：隔离数据根的结构性不变量", () => {
  it("ISO-S1：`CODEM_DATA_HOME` 全仓只有一个读取点，且空串 = 没设", () => {
    /*
     * ⚠️ 只数**生产代码**：`#[cfg(test)] mod tests` 里那几行要读原值/写回去
     * （不变量管的是生产路径有几个读点，测试不是第二个真相）。
     */
    const testAt = storageRs.indexOf("#[cfg(test)]");
    expect(testAt, "前提：storage.rs 里有测试模块").toBeGreaterThan(0);
    const prod = storageRs.slice(0, testAt);
    // 唯一读点：isolated_data_home() 里那一句（用常量名读，不写死字面量）
    expect(
      count(prod, "std::env::var_os(DATA_HOME_ENV)"),
      "`CODEM_DATA_HOME` 的读取点必须唯一（就一处）",
    ).toBe(1);
    // 别处不许直接读这个字面量（否则口径分叉、且静态判据再也数不清有几个读点）
    const rustFiles = [
      "storage.rs",
      "lib.rs",
      "runtime_log.rs",
      "ofm.rs",
      "ilink/mod.rs",
      "phone/mod.rs",
      "phone/connector.rs",
    ];
    for (const f of rustFiles) {
      const src = read("src-tauri/src/" + f);
      const cut = src.indexOf("#[cfg(test)]");
      const code = cut > 0 ? src.slice(0, cut) : src;
      for (const bad of ['var_os("CODEM_DATA_HOME")', 'var("CODEM_DATA_HOME")']) {
        expect(count(code, bad), `${f} 里不许直接读 ${bad}（要走 isolated_data_home）`).toBe(0);
      }
    }
    /*
     * 空串 = 未设置：`set CODEM_DATA_HOME=` 在 Windows 脚本里会留下一个存在的空变量，
     * 而把数据根解析成 `""`（相对的当前目录）正是第 55 轮真事故的形态
     * （数据落进仓库工作目录）。行为面由 Rust 单测 `ISO-2` 钉，这里是源码面。
     */
    const fn = bodyOf(storageRs, "pub(crate) fn isolated_data_home_from(");
    expect(fn, "空串必须被过滤掉（filter(!is_empty)）").toContain("filter(|s| !s.is_empty())");
  });

  it("ISO-S2：`app_data_dir()` 全仓只剩一个调用点（漏一处，隔离就漏一个口子）", () => {
    const hits: Array<{ file: string; line: number; text: string }> = [];
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(path.join(dir, e.name), childRel);
          continue;
        }
        if (!e.name.endsWith(".rs")) continue;
        const src = fs.readFileSync(path.join(dir, e.name), "utf8");
        src.split("\n").forEach((line, i) => {
          // 只看**真的调用**（`//`/`///`/`*` 开头的注释行不算）
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*")) return;
          if (line.includes(".app_data_dir()")) hits.push({ file: childRel, line: i + 1, text: t });
        });
      }
    };
    walk(RUST, "");

    expect(
      hits.map((h) => `${h.file}:${h.line}`),
      "`app_data_dir()` 只允许出现在 lib.rs::app_data_dir_path 一处 —— " +
        "其余调用点在设了隔离根时会把数据写进用户的真目录",
    ).toEqual(["lib.rs:1367"]);
    // 而且那一处必须**先看隔离根**
    const fn = bodyOf(libRs, "pub(crate) fn app_data_dir_path(");
    expect(fn, "唯一入口必须先看隔离根").toContain("storage::isolated_data_home()");
    expect(fn, "拿不到隔离根时才退回 Tauri 的 app_data_dir").toContain("app_data_dir()");
  });

  it("ISO-S3：运行日志 / 崩溃标记 / panic 现场都走同一个入口", () => {
    // 运行日志：隔离根必须**排在** APPDATA 兜底之前
    const logFn = bodyOf(runtimeLogRs, "pub fn default_base_dir()");
    const isolatedAt = logFn.indexOf("isolated_data_home()");
    const appdataAt = logFn.indexOf('var("APPDATA")');
    expect(isolatedAt, "运行日志目录要先看隔离根").toBeGreaterThanOrEqual(0);
    expect(appdataAt, "仍要保留 APPDATA 兜底（默认路径不变）").toBeGreaterThan(0);
    expect(isolatedAt, "隔离根必须排在 APPDATA 之前").toBeLessThan(appdataAt);

    // 崩溃标记（active-run.json）与 panic 现场：都要跟隔离根走
    const marker = bodyOf(libRs, "fn crash_marker_path(");
    expect(marker, "崩溃标记要走 app_data_dir_path（那个唯一入口）").toContain("app_data_dir_path(app)");
    const hook = bodyOf(libRs, "fn install_panic_hook()");
    expect(hook, "panic 现场（codem-crash.log / 运行日志）也要跟隔离根走").toContain(
      "storage::isolated_data_home()",
    );
  });

  it("ISO-S4：功能目录（插件 / 手机 / iLink）也走同一个入口（不许留一个写进真目录的口子）", () => {
    const callers: Array<[string, string]> = [
      ["src-tauri/src/ofm.rs", "crate::app_data_dir_path(&app)"],
      ["src-tauri/src/ilink/mod.rs", "crate::app_data_dir_path(app)"],
      ["src-tauri/src/phone/mod.rs", "crate::app_data_dir_path(app)"],
      ["src-tauri/src/phone/connector.rs", "crate::app_data_dir_path(app)"],
    ];
    for (const [file, needle] of callers) {
      const src = read(file);
      expect(count(src, needle), `${file} 必须走应用数据目录的唯一入口`).toBeGreaterThanOrEqual(1);
    }
    // 手机那一侧原来有**三个**各自读 app_data_dir 的地方（data_dir / phone_dir / app_data_root）
    expect(count(read("src-tauri/src/phone/mod.rs"), "crate::app_data_dir_path(app)")).toBe(3);
  });

  it("ISO-S5：`ensure_isolated_root` 的必需目录表**与 TS 侧实际用的目录名逐条对得上**", () => {
    /*
     * 为什么这条判据必须读**消费方**的源码：那张表如果只是"照抄在注释里的一份清单"，
     * 它迟早会与真实目录名分叉（改了 `sessions` 的名字而隔离根还在建旧的）。
     * 这里从四个真正拼路径的模块里**抽**出目录名，再回表里逐条核对。
     */
    const consumers: Array<{ file: string; pattern: RegExp; dir: string; why: string }> = [
      {
        file: "src/core/storage/session-jsonl.ts",
        pattern: /base\}sessions\$\{sep\}/,
        dir: "sessions",
        why: "权威追加日志 <base>sessions/<sid>.jsonl",
      },
      {
        file: "src/core/storage/attachment-files.ts",
        pattern: /base\}attachments\$\{sep\}/,
        dir: "attachments",
        why: "大附件正文 <base>attachments/<id>-<name>",
      },
      {
        file: "src/core/storage/spill.ts",
        pattern: /baseDir\}spill\$\{sep\}/,
        dir: "spill",
        why: "工具结果溢出 <base>spill/<sid>/…",
      },
      {
        file: "src/core/skill/installer.ts",
        pattern: /dataDir\}\.codem\$\{sep\}skills/,
        dir: ".codem/skills",
        why: "技能安装目录 <base>.codem/skills",
      },
    ];

    const table = storageRs.slice(storageRs.indexOf("pub const ISOLATED_ROOT_SUBDIRS"));
    const tableLine = table.slice(0, table.indexOf(";"));
    for (const c of consumers) {
      const src = read(c.file);
      expect(src, `前提：${c.file} 里能抽到目录名（${c.why}）`).toMatch(c.pattern);
      expect(tableLine, `隔离根的必需目录表缺少「${c.dir}」（${c.why}）`).toContain(`"${c.dir}"`);
    }
    // 表本身要非空（防止有人把整行删掉之后这条判据"空跑通过"）
    expect(count(tableLine, '"'), "必需目录表至少要有 4 条").toBeGreaterThanOrEqual(8);
  });

  it("ISO-S6：默认路径的分支**原样保留**（隔离根是「多一个第 0 档」，不是替换）", () => {
    // 第 0 档必须在最前面，且 `resolve_db_path_full` 在 data_home 为空时**委托**给原来的纯函数
    const full = bodyOf(storageRs, "pub(crate) fn resolve_db_path_full(");
    expect(full, "data_home 为空时必须委托给第 55 轮的 resolve_db_path_from").toContain(
      "resolve_db_path_from(explicit, known_folder, xdg, home, userprofile)",
    );
    const resolve = bodyOf(storageRs, "pub fn resolve_db_path()");
    expect(resolve, "resolve_db_path 要把隔离根作为第 0 档传进去").toContain("isolated_data_home(),");
    // 第 55 轮那五档的来源一个都不许少
    for (const src of [
      'std::env::var_os("CODEM_DB_PATH")',
      "dirs::data_dir()",
      'std::env::var_os("XDG_DATA_HOME")',
      'std::env::var_os("HOME")',
      'std::env::var_os("USERPROFILE")',
    ]) {
      expect(resolve, `resolve_db_path 少了第 55 轮的来源：${src}`).toContain(src);
    }
  });
});
