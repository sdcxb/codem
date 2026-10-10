# 我们对内置副本打的补丁（Codem 侧）

上游：`https://github.com/Ebony-Vinyl/dsh-our-free-model`（MIT，见同目录 `LICENSE`）
内置方式与上游 commit 见 `VENDOR.json`。

Codem 是**浏览器内核**（WebView2）里的界面，调这个本地服务属于**跨源请求** ⇒ 必须由服务端给出
CORS 响应头。上游只在两处给了：

- `OPTIONS` 预检（`src/forward.js` 的 `handle()`）；
- SSE 流式响应（`openStreamHeaders()`）。

而**普通 JSON 响应**（`/health`、`/v1/models`、以及错误应答走的 `json()`）**没有**这些头 ⇒
浏览器会把响应拦下（`Failed to fetch`），于是"列模型"这条路上什么都拿不到。
（预检能过、真正那条响应被拦，是最容易被误判成"服务没起来"的一种失败 —— 本波真机上正是它。）

## 补丁内容（1 行）

`src/forward.js` 的 `json()`：

```diff
 function json(res, status, payload) {
   const body = JSON.stringify(payload)
-  res.writeHead(status, { 'content-type': 'application/json', ... })
+  res.writeHead(status, { ...corsHeaders(), 'content-type': 'application/json', ... })
   res.end(body)
 }
```

`corsHeaders()` 是上游自己的函数（`access-control-allow-origin: *` + 允许
`authorization/content-type/x-api-key` + `GET, POST, OPTIONS`），所以补丁只是把**已有的策略**
补齐到 JSON 这条路上，没有引入新的信任面：服务只监听本机回环地址，`/v1/*` 仍然要 Bearer Key。

## 怎么保证它不会被"重新内置"冲掉

- `_vendor-ofm.mjs`（仓库外的脚手架）在拷完之后**自动重新施加**这条补丁；
- 判据 `src/test/free-model-plugin-vendor.test.ts` 会读这份内置副本，**断言补丁在**（不在就判红）
  —— 于是"重跑内置脚本忘了带补丁"这种事会在门禁里当场暴露，而不是等用户点了模型列表发现是空的。
- 上游若自己补齐了 JSON 的 CORS，这条断言仍然成立（那时它已经是"带 CORS 的 json()"），
  届时可以删掉本文件与补丁、只留断言。
