# Stack 市场签名（RSA-PSS / SHA-256）

> 目标：公开分发的 Codem 安装包里**只有公钥**；私钥只在你的 GitHub Actions Secret（或离线机）里。
> 客户端发现索引没签名/验签失败时**拒绝加载**，不会退回“没签名也照用”。

## 1. 已经生成的东西

| 文件 | 内容 | 是否进仓库 |
|---|---|---|
| `tools/market/market-public-key.pem` | 公钥（App 内置同一把） | ✅ 是 |
| `src/core/skill/market-signature.ts` | 内置公钥 + WebCrypto 验签 | ✅ 是 |
| `stacks/index.json.sig` | 当前索引的签名 | ✅ 是 |
| `%USERPROFILE%\codem-market-signing-key.pem` | **私钥** | ❌ 绝不 |

公钥指纹（SHA-256）：`bf214468029b2b2b77de935ef6710f5bf0cdbdcdf04fb954efba664f7f5cfff7`

## 2. 把私钥放进 GitHub Secret（只做一次）

1. 打开 `C:\Users\abee\codem-market-signing-key.pem`，**整段复制**（含 BEGIN/END 两行）。
2. GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `CODEM_MARKET_SIGNING_KEY`
   - Secret: 粘贴整段私钥。
3. **删除本地私钥文件**（或存进密码管理器）：`Remove-Item C:\Users\abee\codem-market-signing-key.pem`
4. 建发布环境（控制“谁能触发”）：
   - Settings → **Environments** → New environment → 名字 `market-signing`
   - **Required reviewers** 加你自己（GitHub 账号）。
   - 这样即使有人推了 `v*` tag，签名 job 也会停下来等你批准。

## 3. 谁会触发签名？

- 工作流 `.github/workflows/market-sign.yml` 只在 **推 `v*` tag** 或**手动 workflow_dispatch** 时运行；
- 能推 tag 的人 = 仓库 **write** 权限的人（开源项目里外部贡献者没有）；
- Fork 的 PR **拿不到** Secret；
- 再加 Environment 的 required reviewer，等于“双人/本人批准”；
- 结论：公开开源后，普通用户/贡献者无法触发；只有你（或你授权的维护者）能。

## 4. 发布时发生什么

1. 你推 `v1.16.332` tag；
2. Actions 等你在 `market-signing` 环境点 Approve；
3. `node tools/market/sign-index.mjs` 用 Secret 里的私钥签 `stacks/index.json`；
4. `--verify` 先自检；
5. 把 `stacks-index.json` / `stacks-index.json.sig` 上传到该 Release 资产；
6. App 优先拉 `releases/latest/download/stacks-index.json` + `.sig`，验签通过才展示市场；
   老 Release 没有资产时回退 master 的 `stacks/index.json` + `.sig`（仍然必须验签）。

## 5. 本地改索引后怎么签

```powershell
# 私钥还在本地时
node tools/market/sign-index.mjs --key C:\Users\abee\codem-market-signing-key.pem
node tools/market/sign-index.mjs --verify
git add stacks/index.json stacks/index.json.sig
```

忘了重签会被判据 `MARKET-SIG` 拦下（索引改一个字，验签就失败）。

## 6. 轮换/泄露

- 泄露：GitHub 删除 Secret → 用 `gen-key.mjs` 生成新对（先移走旧公钥文件）→ 新公钥进仓库 → 发新版本 → 旧版本 App 仍认旧公钥（过渡期），新版本只认新 key；
- 轮换：公钥文件按 `key id` 列表内置（当前单 key），后续可加 `market-public-key-<id>.pem` 列表，验签时按 key id 选公钥；
- **不要复用** `.tauri/codem-updater.key`：它现在就在仓库里，市场必须独立密钥。
