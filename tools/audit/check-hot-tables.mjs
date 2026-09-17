/**
 * 校验 `HOT_DOMAIN_TABLES` 里的表名都真实存在（`tables.json` 是 `crud.list` 的白名单来源）。
 *
 * 为什么值得一个脚本：写错一个表名不会报错，只会让那张表**永远加载不上**
 * （`crud.list` 拒绝 → 端口按失败上报 → 该表进 `pending` → 面板照样空）。
 * 这正是"预取清单"最容易悄悄失效的方式。
 */
import { readFileSync } from "node:fs";

const tables = JSON.parse(readFileSync("src-tauri/codem-db/sql/tables.json", "utf8")).tables;
const src = readFileSync("src/core/storage/bootstrap.ts", "utf8");
const block = src.match(/HOT_DOMAIN_TABLES: readonly string\[\] = \[([\s\S]*?)\];/);
if (!block) {
  console.error("✗ 没找到 HOT_DOMAIN_TABLES（改名了？）");
  process.exit(1);
}
const names = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
const missing = names.filter((n) => !tables.includes(n));
console.log(`热表 ${names.length} 张；不在 tables.json 里的：${missing.length ? missing.join(", ") : "（无）"}`);
process.exit(missing.length ? 1 : 0);
