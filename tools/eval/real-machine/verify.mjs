/**
 * 真机验证驱动器（CDP，只连本机 9222；只对**副本数据根**操作）。
 *
 * 用法：
 *   node tools/eval/real-machine/verify.mjs <dataDir> compaction <标题> <消息> [超时秒]
 *   node tools/eval/real-machine/verify.mjs <dataDir> routing <每类次数> <prompt...>
 *
 * compaction：
 *   - 用 JS 点开会话、发消息；
 *   - 250ms 轮询 DOM：出现"正在压缩上下文..."就截图（--shot 默认落到当前目录）；
 *   - 收集 console（`[compact] usage` / compactMessages）；
 *   - 轮询副本 DB：visible / hidden / 压缩标记 / 事件。
 *
 * routing：
 *   - 每个 prompt 新建一个会话，发出去，等"消息与工具调用 12 秒不再变化"；
 *   - 从副本 DB 读该会话的 tool_calls 计数，输出每条的转化结果。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [, , dataDir, mode, ...args] = process.argv;
if (!dataDir || !mode) {
  console.error("用法: verify.mjs <dataDir> compaction <标题> <消息> [秒] | routing <次数> <prompt...>");
  process.exit(2);
}
const dbPath = path.join(dataDir, "codem-db-rust.bin");
const dbOpen = () => new DatabaseSync(dbPath, { readOnly: true });

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("没有 CDP page target（应用需带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动）");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push(
      m.params.args
        .map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type))
        .join(" "),
    );
  }
  if (m.method === "Runtime.exceptionThrown") logs.push("[exception] " + (m.params.exceptionDetails.exception?.description ?? ""));
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Runtime.enable");
await send("Page.enable");

const sessionIdByTitle = (title) => {
  const db = dbOpen();
  try {
    return db.prepare("select id from sessions where title = ? limit 1").get(title)?.id
      ?? db.prepare("select id from sessions where title like ? order by last_message_at desc limit 1").get(`%${title}%`)?.id;
  } finally { db.close(); }
};
const sessionStats = (sid) => {
  const db = dbOpen();
  try {
    const count = (sql) => db.prepare(sql).get(sid).c;
    return {
      visible: count("select count(*) c from messages where session_id=? and hidden=0"),
      hidden: count("select count(*) c from messages where session_id=? and hidden=1"),
      markers: count("select count(*) c from messages where session_id=? and content like '%[上下文已%压缩]%'"),
      tools: db.prepare("select tc.tool, count(*) c from tool_calls tc join messages m on m.id=tc.message_id where m.session_id=? group by tc.tool order by c desc").all(sid),
    };
  } finally { db.close(); }
};
const openSession = async (title) => {
  const found = await ev(`(() => {
    const click = (el) => { el.click(); return el.textContent.trim(); };
    const all = [...document.querySelectorAll('.sidebar-session-title')];
    const exact = all.find((e) => e.textContent.trim() === ${JSON.stringify(title)});
    if (exact) return click(exact);
    const near = all.find((e) => e.textContent.includes(${JSON.stringify(title)}));
    if (near) return click(near);
    return null;
  })()`);
  if (!found) {
    // 会话可能在折叠的项目里：逐个点开项目分组
    const n = await ev(`document.querySelectorAll('.sidebar-project-header').length`);
    for (let i = 0; i < n; i += 1) {
      const hit = await ev(`(() => {
        const h = document.querySelectorAll('.sidebar-project-header')[${i}];
        h?.click();
        const e = [...document.querySelectorAll('.sidebar-session-title')].find((x) => x.textContent.trim() === ${JSON.stringify(title)} || x.textContent.includes(${JSON.stringify(title)}));
        if (!e) return null;
        e.click();
        return e.textContent.trim();
      })()`);
      await sleep(400);
      if (hit) return hit;
    }
    return null;
  }
  return found;
};

if (mode === "compaction") {
  const title = args[0];
  const message = args[1];
  const timeoutSec = Number(args[2] ?? 300);
  const sid = sessionIdByTitle(title);
  const before = sid ? sessionStats(sid) : null;
  const opened = await openSession(title);
  await sleep(2000);
  await ev(`(() => { const ta=document.querySelector('textarea.message-input'); if(!ta) return false; ta.focus(); const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set; s.call(ta,${JSON.stringify(message)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const sent = await ev(`(() => { const b=document.querySelector('button.send-btn'); if(!b||b.disabled) return false; b.click(); return true; })()`);
  const started = Date.now();
  let banner = null;
  let shot = null;
  while (Date.now() - started < timeoutSec * 1000) {
    await sleep(250);
    const found = await ev(`(() => { const m = document.body.innerText.match(/(正在压缩[^\\n]{0,40}|压缩上下文[^\\n]{0,40}|上下文已满[^\\n]{0,40}|上下文即将[^\\n]{0,40})/); return m ? m[0] : null; })()`);
    if (found && !banner) {
      banner = found;
      const png = await send("Page.captureScreenshot", { format: "png" });
      if (png.result?.data) {
        shot = path.resolve("real-compact-banner.png");
        fs.writeFileSync(shot, Buffer.from(png.result.data, "base64"));
      }
    }
    const done = await ev(`(() => { const b=document.querySelector('button.send-btn'); return b ? !b.disabled : false; })()`);
    if (banner && done) break;
  }
  console.log(JSON.stringify({
    opened, sent, banner, screenshot: shot,
    before, after: sid ? sessionStats(sid) : null,
    logs: logs.filter((l) => /\[compact\]|compactMessages|context window/.test(l)).slice(-30),
    writeFailures: logs.filter((l) => /超过 60 秒|只存在内存|IPC 疑似挂死/.test(l)).slice(0, 10),
  }, null, 1));
} else if (mode === "routing") {
  const each = Number(args[0] ?? 1);
  const prompts = args.slice(1);
  const results = [];
  for (const prompt of prompts) {
    for (let k = 0; k < each; k += 1) {
      /**
       * 新对话是**草稿**：DB 里要等第一条消息才建会话行 —— 所以不能"点完就查最新会话"。
       * 这里只等输入框出现；发完再按"created_at >= 点击时刻"找回会话。
       */
      const startedAt = Date.now();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await ev(`(() => { const b=[...document.querySelectorAll('.sidebar-nav-item')].find((e)=>e.textContent.trim()==='新对话'); b?.click(); return !!b; })()`);
        await sleep(1200);
        const ready = await ev(`!!document.querySelector('textarea.message-input')`);
        if (ready) break;
      }
      await ev(`(() => { const ta=document.querySelector('textarea.message-input'); ta.focus(); const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta),'value').set; s.call(ta,${JSON.stringify(prompt)}); ta.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(300);
      const clicked = await ev(`(() => { const b=document.querySelector('button.send-btn'); if(!b||b.disabled) return false; b.click(); return true; })()`);
      let session = null;
      for (let i = 0; i < 12 && !session; i += 1) {
        await sleep(500);
        const d = dbOpen();
        session = d.prepare("select id, title from sessions where created_at >= ? order by created_at desc limit 1").get(startedAt - 3000);
        d.close();
      }
      if (!session) {
        results.push({ prompt, session: null, clicked, skipped: "发完没找到新会话行", tools: [] });
        console.log(JSON.stringify(results[results.length - 1]));
        continue;
      }
      let prev = sessionStats(session.id);
      let stable = 0;
      const started = Date.now();
      while (Date.now() - started < 240000) {
        await sleep(2000);
        const now = sessionStats(session.id);
        const busy = await ev(`(() => { const b=document.querySelector('button.send-btn'); return b ? b.disabled : false; })()`);
        const same = now.visible === prev.visible && now.tools.length === prev.tools.length;
        stable = same ? stable + 1 : 0;
        prev = now;
        if (stable >= 6 && !busy) break;
      }
      const stats = sessionStats(session.id);
      results.push({ prompt, session: session.title, clicked, elapsedSec: Math.round((Date.now() - started) / 1000), tools: stats.tools });
      console.log(JSON.stringify(results[results.length - 1]));
    }
  }
  console.log("SUMMARY " + JSON.stringify(results, null, 1));
} else {
  console.error("未知 mode：" + mode);
  process.exit(2);
}
ws.close();
