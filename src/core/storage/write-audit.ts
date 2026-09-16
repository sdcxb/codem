/**
 * 存储写操作审计（第 31 轮事故的产物，**长期保留**）
 *
 * ## 为什么需要它
 *
 * 真机事故：迁移对账通过、标记已写之后，新库的 `messages / sessions /
 * session_events / tool_calls` 被一次性清空（821 / 3 / 2131 / 883）。
 * 排查过程暴露了两个"看不见"的问题：
 *
 * 1. **端口不止一个写入口**。第一版只在 `data.execute` / `data.write` /
 *    `data.command` 上装了审计，结果复现时什么都没记到 —— 而 SQLite 侧的
 *    删除审计（`codem-db` 的 `audit.rs` 触发器）明明记下了 3000 条删除。
 *    原因是有第三条路：`port.domains.applyDelete*` 只改镜像，**Rust 侧的删除
 *    由各自调用点直接 `data.execute("crud.delete")` 发出**。
 * 2. **只在"我以为的"那个函数里插桩会漏**。`domainDelete` 装了栈追踪，
 *    结果是 0 条记录 —— 删除走的是 `domainDeleteBeyond` / `domainDeleteWhere`
 *    这些"兄弟函数"，它们各自 `execute`，谁也不经过谁。
 *
 * 结论：审计必须挂在**所有写穿路径共同经过的那一处**，并且**记录调用栈**
 * （"删了什么"SQLite 侧已经答了；这里要答的是"**谁**删的"）。
 *
 * ## 设计
 *
 * - `recordWrite()`：所有写穿调用前调用，记录操作、表名、关键字段与**调用栈**；
 * - 环形缓冲（有界）：不会因为"跑得久"而吃内存；
 * - 只在内存里，不写盘、不碰数据库 —— 审计本身绝不能成为新的写路径。
 */

interface WriteRecord {
  at: number;
  /** 写命令名（`crud.delete` / `messages.upsert_index` / …） */
  command: string;
  /** 目标表（能从参数里取到就有） */
  table?: string;
  /** 关键定位信息（where / id / session_id） */
  key?: string;
  /** 调用栈（去掉首行，只留 `at …` 那些帧） */
  stack: string[];
}

const CAPACITY = 400;
const buffer: WriteRecord[] = [];

/** 记录一次写穿（由 `domain-store` 的公共写穿函数统一调用） */
export function recordWrite(command: string, params?: Record<string, unknown>): void {
  try {
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2, 12) // 去掉 "Error" 与 recordWrite 自身
      .map((l) => l.trim());
    buffer.push({
      at: Date.now(),
      command,
      table: params?.table === undefined ? undefined : String(params.table),
      key: summarizeKey(params),
      stack,
    });
    if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
    if (command.includes("delete") || command.includes("replace_table")) {
      /*
       * 删除类写操作**打一条**控制台记录（带调用栈）。
       *
       * 为什么要打到控制台而不是只留在内存缓冲：第 31 轮事故里缓冲装了却看不见 ——
       * 生产 bundle 的内存缓冲没法从外部读，而控制台可以（真机验收脚本经 CDP 读）。
       * 只记删除类，避免正常写入刷屏；正文一律不记。
       */
      console.warn(
        `[WriteAudit] ${command} table=${String(params?.table ?? "-")} ${summarizeKey(params) ?? ""}\n` +
          stack.slice(0, 8).join("\n"),
      );
    }
  } catch {
    /* 审计失败绝不影响功能 */
  }
}

/** 从参数里挑出"能定位这一行"的信息（不记正文） */
function summarizeKey(params?: Record<string, unknown>): string | undefined {
  if (!params) return undefined;
  const where = params.where as Record<string, unknown> | undefined;
  if (where) return JSON.stringify(where).slice(0, 200);
  if (typeof params.id === "string") return params.id;
  if (typeof params.session_id === "string") return `session=${params.session_id}`;
  if (Array.isArray(params.rows)) return `${(params.rows as unknown[]).length} 行`;
  return undefined;
}

/** 最近的写操作（**删除类在前**，便于排查） */
export function recentWrites(opts: { limit?: number; onlyDeletes?: boolean } = {}): WriteRecord[] {
  const limit = opts.limit ?? 100;
  const list = opts.onlyDeletes
    ? buffer.filter((r) => r.command.includes("delete") || r.command.includes("replace_table"))
    : buffer;
  return list.slice(-limit);
}

/** 删除类写操作的条数（诊断：事故后"到底有没有渲染侧发起删除"） */
export function deleteWriteCount(): number {
  return buffer.filter((r) => r.command.includes("delete")).length;
}

/** 清空（测试与排查收尾用） */
export function clearWriteAudit(): void {
  buffer.length = 0;
}
