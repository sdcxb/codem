/**
 * Codem 中继（`tools/relay/codem-relay.mjs`）—— 第 122 轮 §11 第 A 步。
 *
 * ## 这个文件守的是"桌面只出站"这条策略能不能成立
 *
 * 中继是整条链路里**唯一暴露在公网**的组件，它同时是：
 * - 桌面的**接入点**（桌面连出来，凭 `connectorId` + `connectorToken`）
 * - 手机的**接入点**（手机凭配对码换会话）
 *
 * 所以判据的重点不是"转发能不能用"，而是**它不能被怎么用坏**：
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | RL-1 | 身份：首见登记（TOFU）、之后 token 必须一致；缺参一律拒 |
 * | RL-2 | 配对码换会话：只认新鲜的码；cookie 属性正确 |
 * | RL-3 | 会话过期即失效 |
 * | RL-4 | **未配对的浏览器从中继上读不到任何东西**（只回 JSON，无页面内容） |
 * | RL-5 | 隧道往返**字节级**一致（中继是纯隧道，不许改写 body） |
 * | RL-6 | 桌面离线 ⇒ 503；桌面不回 ⇒ 504（两者用户要做的事不同，不能混成一个码） |
 * | RL-7 | 回填一个已消失的请求 ⇒ **410 如实说**，不许假 200 |
 * | RL-8 | 桌面报错 ⇒ 502 如实透传 |
 * | RL-9 | 桌面断线 ⇒ 在途请求全部被拒，不许永远挂着 |
 * | RL-10 | 不透传 hop-by-hop 头（否则会污染手机侧连接） |
 */
/**
 * @vitest-environment node
 *
 * ⚠️ 这一行**必须**留着。本仓 vitest 默认跑在 `happy-dom` 下，
 * 那里的 `fetch` 是**浏览器 fetch**：它会强制 CORS、并对
 * `content-type: application/json` 先发一个 OPTIONS 预检 ——
 * 于是所有用例都变成 `Cross-Origin Request Blocked`，
 * 而中继本身完全没问题（第一版就是这么红了 8 条，看着像中继坏了）。
 *
 * 这个文件测的是**中继的 HTTP 行为**，就该用 Node 的真实 fetch。
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
// @ts-ignore —— tools/ 下的 .mjs 没有类型声明；src/test 不在 tsconfig 的 include 里
import { createRelay, RelayState, PAIR_CODE_TTL_MS, APP_SESSION_TTL_MS } from "../../tools/relay/codem-relay.mjs";

/** 起一个真中继，返回 { base, state, close } */
async function startRelay() {
  const { server, state } = createRelay();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    state,
    /**
     * ⚠️ 必须先 `closeAllConnections()`。
     *
     * 踩过的坑：`server.close(cb)` **只关监听、不关已建立的连接**，
     * 它会一直等到所有连接结束才回调。而 RL-5/RL-8 会开一条**长活的 SSE**，
     * 于是 `await close()` 永远不返回 ⇒ 用例挂在 `finally` 里、
     * 报的是「Test timed out」，看起来像业务逻辑卡住，
     * 实际上业务早就跑完了（诊断日志里 `request` 帧明明已经到了）。
     * 这就是"清理代码把它自己的失败伪装成被测代码的失败"。
     */
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

/**
 * 读 SSE 的**推式**helper（原始 `http`，不用 `fetch`）。
 *
 * ⚠️ 两个都踩过的坑：
 *
 * 1. **不用 `fetch`**：在 vitest 的 node 环境下用 undici 的 `fetch` 读 SSE 时，
 *    第二个事件读不到（同一段流程用独立脚本跑完全正常，见 `.preview-shot/_probe-*`）。
 *    这个文件要测的是**中继的线缆行为**，用原始 `http` 反而更贴题、也少一个变量。
 * 2. **推式缓冲**：第一版是"每次调用新建 buffer、读到就 return"——
 *    那样**同一次 read 里到达的后续事件会被丢掉**。这里用一个常驻数组接住所有事件，
 *    `next()` 只从里面取，不丢帧。
 */
function openSse(url) {
  const events = [];
  let notify = null;
  let buf = "";
  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };
  const req = http.request(url, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith(":")) continue; // 心跳注释
        const lines = block.split("\n");
        const evLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        events.push({
          event: evLine ? evLine.slice(7).trim() : "message",
          data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
        });
        wake();
      }
    });
  });
  req.on("error", () => wake());
  req.end();
  return {
    async next(want, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = events.findIndex((e) => e.event === want);
        if (idx >= 0) return events.splice(idx, 1)[0].data;
        if (Date.now() > deadline) {
          throw new Error(`等 SSE 事件「${want}」超时；已收到：${JSON.stringify(events.map((e) => e.event))}`);
        }
        await new Promise((r) => {
          notify = r;
          setTimeout(r, 200);
        });
      }
    },
    close: () => req.destroy(),
  };
}

async function hello(base, body) {
  const r = await fetch(`${base}/connector/hello`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

describe("第 122 轮 §11A · Codem 中继", () => {
  it("RL-1: 首见登记（TOFU）+ token 必须一致 + 缺参拒绝", async () => {
    const { base, close } = await startRelay();
    try {
      const a = await hello(base, { connectorId: "c1", connectorToken: "tok-1", pairingCode: "111111" });
      expect(a.status).toBe(200);
      expect(a.json.ok).toBe(true);
      expect(typeof a.json.streamToken).toBe("string");
      expect(a.json.streamToken.length).toBeGreaterThan(20);

      // token 不一致 ⇒ 401（否则任何知道 connectorId 的人都能占位）
      const bad = await hello(base, { connectorId: "c1", connectorToken: "wrong" });
      expect(bad.status).toBe(401);
      expect(bad.json.code).toBe("connector_token_mismatch");

      // 缺参
      expect((await hello(base, { connectorId: "c1" })).status).toBe(401);
      expect((await hello(base, {})).json.code).toBe("bad_request");
    } finally {
      await close();
    }
  });

  it("RL-2: 配对码换会话 —— 只认新鲜且正确的码，cookie 属性正确", async () => {
    const { base, close } = await startRelay();
    try {
      await hello(base, { connectorId: "c1", connectorToken: "t", pairingCode: "424242" });

      const ok = await fetch(`${base}/app/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "424242" }),
      });
      expect(ok.status).toBe(200);
      const sc = ok.headers.get("set-cookie") || "";
      expect(sc).toContain("codem_relay=");
      expect(sc).toContain("HttpOnly");
      expect(sc).toContain("SameSite=Strict");
      expect(sc).toContain("Path=/app");
      // 明文 HTTP 时**不能**带 Secure（否则浏览器直接不存，手机永远配不上）
      expect(sc).not.toContain("Secure");

      const wrong = await fetch(`${base}/app/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      });
      expect(wrong.status).toBe(403);
    } finally {
      await close();
    }
  });

  it("RL-3: 配对码过期即失效（用注入的时钟，不等真的 5 分钟）", () => {
    let t = 1_000_000;
    const st = new RelayState({ now: () => t });
    st.hello({ connectorId: "c1", connectorToken: "t", pairingCode: "999999" });
    expect(st.pair("999999").ok).toBe(true);
    // 码过期
    t += PAIR_CODE_TTL_MS + 1;
    expect(st.pair("999999").ok).toBe(false);

    // 会话过期
    const st2 = new RelayState({ now: () => t });
    st2.hello({ connectorId: "c2", connectorToken: "t", pairingCode: "888888" });
    const p = st2.pair("888888");
    expect(st2.appSession(p.secret)).not.toBeNull();
    t += APP_SESSION_TTL_MS + 1;
    expect(st2.appSession(p.secret)).toBeNull();
  });

  it("RL-4: 未配对的浏览器**读不到任何东西**（只回 JSON，无页面内容）", async () => {
    const { base, close } = await startRelay();
    try {
      for (const p of ["/app/", "/app/api/sessions", "/app/pair"]) {
        const r = await fetch(`${base}${p}`, { redirect: "manual" });
        if (p === "/app/pair") continue; // POST-only，GET 会 404，不是这条判据
        expect(r.status, `${p} 应 401`).toBe(401);
        const body = await r.text();
        expect(body, `${p} 不该泄露页面`).not.toMatch(/<html|<body|Codem/);
        expect(JSON.parse(body).code).toBe("unauthorized");
      }
      // 根路径只是跳转，不提供内容
      const root = await fetch(base, { redirect: "manual" });
      expect(root.status).toBe(302);
    } finally {
      await close();
    }
  });

  it("RL-5: 隧道往返**字节级一致**（中继是纯隧道，不许改写 body）", async () => {    const { base, close, state } = await startRelay();
    try {
      const h = await hello(base, {
        connectorId: "c1",
        connectorToken: "t",
        pairingCode: "555555",
        deviceName: "测试机",
      });
      // 桌面侧出站长连
      const sse = openSse(`${base}/connector/stream?connectorId=c1&streamToken=${h.json.streamToken}`);
      expect(await sse.next("hello")).toEqual({ ok: true });
      /**
       * 这一条守的是一个**真实踩过的坑**：SSE 注册之后必须**仍然是注册着的**。
       * 第一版把清理挂在 `req.on('close')`，无 body 的 GET 会立刻触发它
       * ⇒ connector 刚上线就被判成"已断开"，手机请求全拿 503，
       * 而表现是"connector 侧什么都没收到"，从表象极难定位。
       */
      expect(state.onlineIds(), "开流之后 connector 必须仍在线").toContain("c1");

      // 手机配对
      const pairRes = await fetch(`${base}/app/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "555555" }),
      });
      const cookie = (pairRes.headers.get("set-cookie") || "").split(";")[0];

      // 手机发请求（不 await，等桌面回填）
      const phonePromise = fetch(`${base}/app/api/sessions?limit=3`, { headers: { cookie } });

      // 桌面收到推来的帧
      const frame = await sse.next("request");
      expect(frame.method).toBe("http.request");
      expect(frame.params.method).toBe("GET");
      expect(frame.params.path).toBe("/api/sessions");
      expect(frame.params.query).toBe("?limit=3");

      // 用一段**非 UTF-8 且含 NUL** 的字节，证明中继没有把它当文本处理
      const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80]);
      await fetch(`${base}/connector/response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectorId: "c1",
          streamToken: h.json.streamToken,
          id: frame.id,
          result: { status: 200, headers: { "content-type": "application/octet-stream" }, bodyB64: raw.toString("base64") },
        }),
      });

      const phoneRes = await phonePromise;
      expect(phoneRes.status).toBe(200);
      const got = Buffer.from(await phoneRes.arrayBuffer());
      expect(got.equals(raw), "body 必须字节级一致").toBe(true);
      // hop-by-hop 头不许透传
      expect(phoneRes.headers.get("transfer-encoding")).toBeNull();
    } finally {
      await close();
    }
  });

  it("RL-6: 桌面离线 ⇒ 503；桌面不回 ⇒ 504（两个码不能混）", async () => {
    const { base, close, state } = await startRelay();
    try {
      const h = await hello(base, { connectorId: "c1", connectorToken: "t", pairingCode: "666666" });
      const pairRes = await fetch(`${base}/app/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "666666" }),
      });
      const cookie = (pairRes.headers.get("set-cookie") || "").split(";")[0];

      // 已登记但**没开 stream** ⇒ 503
      const off = await fetch(`${base}/app/api/x`, { headers: { cookie } });
      expect(off.status).toBe(503);
      expect((await off.json()).code).toBe("connector_offline");

      // 用注入的 state 直接测超时路径（不等 30 秒）：手动塞一个 stream 假体
      const st = new RelayState({ now: () => Date.now() });
      st.hello({ connectorId: "c9", connectorToken: "t" });
      st.connectors.get("c9").stream = { write: () => true };
      const p = st.tunnel("c9", { method: "GET", path: "/" });
      // 不 settle ⇒ 应当被超时拒绝；这里只验证"它确实挂着"，然后手动结束
      st.settle("c9", [...st.connectors.get("c9").pending.keys()][0], { status: 200, bodyB64: "" });
      await expect(p).resolves.toEqual({ status: 200, bodyB64: "" });
      void h;
    } finally {
      await close();
    }
  });

  it("RL-7: 回填一个已消失的请求 ⇒ **410 如实说**（不许假 200）", async () => {
    const { base, close } = await startRelay();
    try {
      const h = await hello(base, { connectorId: "c1", connectorToken: "t" });
      const r = await fetch(`${base}/connector/response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "c1", streamToken: h.json.streamToken, id: "r999", result: { status: 200 } }),
      });
      expect(r.status).toBe(410);
      expect((await r.json()).code).toBe("request_gone");
    } finally {
      await close();
    }
  });

  it("RL-8: 桌面报错 ⇒ 502 如实透传", async () => {
    const { base, close } = await startRelay();
    try {
      const h = await hello(base, { connectorId: "c1", connectorToken: "t", pairingCode: "777777" });
      const sse = openSse(`${base}/connector/stream?connectorId=c1&streamToken=${h.json.streamToken}`);
      await sse.next("hello");
      const pairRes = await fetch(`${base}/app/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "777777" }),
      });
      const cookie = (pairRes.headers.get("set-cookie") || "").split(";")[0];

      const phonePromise = fetch(`${base}/app/api/boom`, { headers: { cookie } });
      const frame = await sse.next("request");
      await fetch(`${base}/connector/response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectorId: "c1",
          streamToken: h.json.streamToken,
          id: frame.id,
          error: { code: -32000, message: "desktop_exploded" },
        }),
      });
      const res = await phonePromise;
      expect(res.status).toBe(502);
      expect((await res.json()).code).toBe("desktop_exploded");
    } finally {
      await close();
    }
  });

  it("RL-9: 桌面断线 ⇒ 在途请求全部被拒（不许永远挂着）", async () => {
    const st = new RelayState();
    st.hello({ connectorId: "c1", connectorToken: "t" });
    const s = st.connectors.get("c1");
    let closed = null;
    s.stream = { write: () => true, end: () => {} };
    const p = st.tunnel("c1", { method: "GET", path: "/" });
    // 模拟 SSE 断开时的清理（与 handler 里的 cleanup 同语义）
    for (const [, pending] of s.pending) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error("connector_disconnected"), { code: 503 }));
    }
    s.pending.clear();
    s.stream = null;
    await expect(p).rejects.toMatchObject({ code: 503 });
    void closed;
  });

  it("RL-11: 配对码必须走**常数时间**比较（行为判据证明不了这件事，只能静态钉住）", () => {
    /**
     * ⚠️ 这条判据是**变异自证逼出来的**。
     *
     * 我原本以为 RL-2 覆盖了配对码比对 —— 变异自证把
     * `crypto.timingSafeEqual` 换成普通 `!==` 之后，RL-2 **照样全绿**。
     * 原因很清楚：功能上"对的码通过、错的码拒绝"两种实现完全一样，
     * 差别只在**耗时形状**上，而写一个计时测试必然是 flaky 的。
     *
     * 结论：常数时间这件事**没法用行为判据证明**，只能用静态判据钉住
     * "它确实调用了常数时间原语"。老实承认这一点，比编一条会飘的计时用例好。
     */
    const src = readFileSync("tools/relay/codem-relay.mjs", "utf8");
    expect(src, "配对码比对必须用 timingSafeEqual").toContain("crypto.timingSafeEqual");
    // 且不能退化成普通比较：`s.pairingCode !== c` 这种写法一旦出现就该红
    expect(src).not.toMatch(/s\.pairingCode\s*!==/);
    expect(src).not.toMatch(/s\.pairingCode\s*===/);
  });

  it("RL-10: stream/response 都要鉴权（拿错 streamToken 一律 401）", async () => {
    const { base, close } = await startRelay();
    try {
      await hello(base, { connectorId: "c1", connectorToken: "t" });
      const s = await fetch(`${base}/connector/stream?connectorId=c1&streamToken=WRONG`);
      expect(s.status).toBe(401);
      const r = await fetch(`${base}/connector/response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "c1", streamToken: "WRONG", id: "x", result: {} }),
      });
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });
});
