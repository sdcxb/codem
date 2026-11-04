/**
 * 文档索引的**测试注入缝**（只被 `src/test/**` 引用）。
 *
 * @unwired 生产不可达是**有意的**：这些 setter 只服务判据（假后端注入/清空 ledger），
 * 生产代码禁止 import 本文件。登记见 `tools/audit/reachability-allowlist.json` 与 `knip.json`。
 *
 * 为什么单独一个文件：knip 的配置把 `src/test/**` 整个忽略，
 * 于是"只被测试用的导出"在它眼里等于"没人用"。把这类**有意的测试缝**集中到一处，
 * 就能在 `knip.json` 里用**一条**带理由的登记覆盖，而不是给生产模块加通配忽略
 * （那会把将来真正的死代码一起藏起来）。
 */

export {
  setDocumentBackend,
  __resetDocumentBackendForTests,
  BLOB_CHUNK_BYTES,
} from "./client";
export { __resetDocumentLedgerForTests } from "./ledger";
