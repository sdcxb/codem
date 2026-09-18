# Codem 发布指南（构建 + 签名 + GitHub Release）

> 来源：v1.9.0 发布成功经验（2026-09-01）。**直接跑 `npm run tauri:build` 会卡死**——updater 签名需要解密密钥，密钥是加密的（`rsign encrypted secret key`），tauri CLI 会等交互输入密码，超时无响应。

## 标准发布流程

### 1. 版本号

修改三处（`src-tauri/Cargo.lock` 由构建自动更新，需单独 commit）：

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`

同步更新 `CHANGELOG.md`（顶部加 `## [x.y.z] - 日期` 条目）、`docs/PROJECT-GUIDE.md` 版本历史。

### 2. 构建 + 签名（关键）

**必须设置签名环境变量后跑 tauri build**，否则卡在密码输入：

```powershell
cd C:\mimo-gui
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
node node_modules\@tauri-apps\cli\tauri.js build
```

关键点：

- 密钥是**加密的**（base64 头部 `untrusted comment: rsign encrypted secret key`），密码固定为 **`dummy`**（见 `build-release.ps1:38`）
- 空密码也会卡死（CLI 等交互输入）
- 项目根有 `build-release.ps1`（已 git 跟踪）封装了完整流程，可 `.\build-release.ps1` 直接跑

### 3. 生成 latest.json（updater 清单）

签名完成后生成 `latest.json`（tauri 不会自动生成）。
**别手写**，用现成的生成器 + 校验器（两者都在仓库里）：

```powershell
node .preview-shot/_audit/make-latest-json.mjs <x.y.z> "<本次更新说明>"
node tools\release\verify-update-manifest.mjs            # 本地四步：键/清单/签名/产物
node tools\release\verify-update-manifest.mjs --remote   # 外加比对 GitHub 上的 sha256
```

> ⚠️ **`platforms` 的键必须是 `windows-x86_64`**（第 54 轮真机查实的坑，见 `CHANGELOG` 1.16.85）。
>
> 这份文档**原来写的是 `platforms = @{ windows = ... }`** —— 那是 Tauri **v1** 的写法，
> v2 的更新器按 `{os}-{arch}-{installer}` / `{os}-{arch}` 找键
> （`tauri-plugin-updater-2.10.1/src/updater.rs:578-597`），两个候选都找不到就报
> `None of the fallback platforms ["windows-x86_64"] were found in the response platforms object`。
> 于是**从这份文档照抄出来的每一个版本，"检查更新"都是坏的**（界面显示"更新失败: …"，
> 诚实但不工作），而开发机上完全看不出来：清单能生成、资产能上传、端点也返回 200。
>
> 现在要**两个键都给**（同一个包、同一份签名）：
> - `windows-x86_64-nsis`：装成 NSIS 包时更新器**先**找它；
> - `windows-x86_64`：兜底（直接跑 `target/release/codem.exe` 时只找这一个）。
>
> **不要**再留 `windows` 这种 v1 键：它在这条链路上永远不会被读到，只会让下一个人以为写全了。
> `VERSION-5`（`src/test/version-consistency.test.ts`）已经把这个契约变成机器约束。

<details>
<summary>手写时的样子（仅供对照，请用上面的生成器）</summary>

```powershell
$Version = "x.y.z"
$nsisSig = (Get-Content "src-tauri\target\release\bundle\nsis\Codem_${Version}_x64-setup.exe.sig" -Raw).Trim()
$entry = @{
    signature = $nsisSig
    url = "https://github.com/sdcxb/codem/releases/download/v$Version/Codem_${Version}_x64-setup.exe"
}
$latestJson = @{
    version = $Version
    notes = "Codem v$Version"
    pub_date = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    platforms = @{ "windows-x86_64-nsis" = $entry; "windows-x86_64" = $entry }
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText("$PWD\latest.json", $latestJson, (New-Object System.Text.UTF8Encoding($false)))
```

（⚠️ 别用 `Set-Content -Encoding UTF8`：它会写 BOM，JSON 解析端会踩坑。）
</details>

### 4. 提交 + 推送

```powershell
git add src-tauri/Cargo.lock   # 版本同步
git commit -m "chore: sync Cargo.lock version to x.y.z"
git push origin master
```

### 5. 创建 GitHub Release + 上传资产

```powershell
gh release create v$Version --repo sdcxb/codem --title "..." --notes "..."
gh release upload v$Version --repo sdcxb/codem `
  "src-tauri\target\release\bundle\nsis\Codem_${Version}_x64-setup.exe" `
  "src-tauri\target\release\bundle\nsis\Codem_${Version}_x64-setup.exe.sig" `
  "src-tauri\target\release\bundle\msi\Codem_${Version}_x64_en-US.msi" `
  "src-tauri\target\release\bundle\msi\Codem_${Version}_x64_en-US.msi.sig" `
  "src-tauri\target\release\latest.json"
```

Release notes 从 `CHANGELOG.md` 对应版本段落取。

### 6. 验证

```powershell
gh release view v$Version --repo sdcxb/codem   # 应有 5 个 asset
```

> ⚠️ **发布后不要立刻用「检查更新」下结论**（第 61 轮实测）：`releases/latest/download/latest.json`
> 这个入口走 GitHub 的 CDN，**传播有几秒到几分钟的滞后**。本轮刚发布 1.16.90 后，
> 已装的 1.16.89 立刻 `updater.check()` 返回的是 **no update**（拿到的是上一版清单的缓存），
> 45 秒后再查就正确返回 `1.16.90`。所以：
> ①`verify-update-manifest.mjs --remote` 认的是**资产与签名的字节一致**（那个是即时的），
> ②"更新器能不能发现新版本"要**隔一会儿再查一次**再下结论，别把它当成更新链路坏了。

产物完整性检查：

- `bundle\msi\Codem_<ver>_x64_en-US.msi` + `.msi.sig`
- `bundle\nsis\Codem_<ver>_x64-setup.exe` + `.exe.sig`
- `latest.json`（含 signature + url）

## 关键路径

| 项 | 路径 |
|---|---|
| 签名私钥 | `.tauri\codem-updater.key`（348B base64，加密） |
| 公钥 | `.tauri\codem-updater.key.pub`（152B） |
| 签名密码 | `dummy`（定义于 `build-release.ps1`） |
| 发布脚本 | `build-release.ps1` |
| updater 公钥 | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |

## 教训 / 陷阱

- **不要信构建日志里的版本号**——`.codem-cache\tauri-build.log` 可能是旧构建残留。验证版本要看磁盘产物的 `VersionInfo.FileVersion/ProductVersion` + 文件时间戳。
- 签名密钥 `codem-updater.key` 已被 git 跟踪（`.gitignore` 注释说 "NEVER commit" 但历史提交已含），当前不阻塞发布；建议后续从仓库移除并轮换。
- `npx tauri` 在 PowerShell 传参可能解析失败，用 `node node_modules\@tauri-apps\cli\tauri.js` 直接调 CLI。
