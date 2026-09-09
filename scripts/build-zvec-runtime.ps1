# ============================================================
# build-zvec-runtime.ps1 — 构建 zvec-grep 发布产物（单合并包：Node + 运行时 + 模型）
#
# 产出（Release 时随 tag 上传，供市场卡片「一键安装」与「离线包导入」）：
#   codem-zvec-win-x64.zip —— 解压到 <runtime 根> 后即得：
#       runtime/node/…  便携 Node（随包发布，安装免访问 nodejs.org/npmmirror）
#       runtime/zg/…     zg 裁剪运行时（dist + 精简 node_modules）
#       models/…         potion-code-16m-v2 模型缓存（MIT，可再分发）
#
# 用法：
#   .\scripts\build-zvec-runtime.ps1                      # 默认源/缓存
#   .\scripts\build-zvec-runtime.ps1 -ZvecSrc <pkgDir> -ModelCache <cacheDir> -Out <dir>
#
# 裁剪策略（仅 Windows x64 目标）：
#   - 剔除 @node-llama-cpp（GGUF 后端，Model2Vec/ONNX 不需要，~700MB）
#   - 剔除 onnxruntime-web（浏览器端，~90MB）
#   - onnxruntime-node 仅保留 win32/x64 平台二进制
# ============================================================

param(
  [string]$ZvecSrc = "",
  [string]$ModelCache = "",
  [string]$NodeVersion = "24.19.0",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # C:\mimo-gui
Set-Location $root

if (-not $ZvecSrc) {
  $ZvecSrc = Join-Path (npm root -g) "@zvec\zvec-grep"
}
if (-not (Test-Path (Join-Path $ZvecSrc "dist\cli\index.js"))) {
  throw "ZvecSrc 无效（缺 dist/cli/index.js）: $ZvecSrc"
}
if (-not $ModelCache) {
  $ModelCache = Join-Path $root ".codem-cache\zg-lab\cache-code"
}
if (-not (Test-Path (Join-Path $ModelCache "model2vec"))) {
  throw "ModelCache 无效（缺 model2vec/）: $ModelCache"
}
if (-not $Out) {
  $Out = Join-Path $root ".codem-cache\zvec-release"
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$staging = Join-Path $Out ".staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
$nodeOut = Join-Path $staging "zvec\runtime\node"
$zgOut = Join-Path $staging "zvec\runtime\zg"
$modelsOut = Join-Path $staging "zvec\models"
New-Item -ItemType Directory -Force -Path $nodeOut | Out-Null
New-Item -ItemType Directory -Force -Path $zgOut | Out-Null
New-Item -ItemType Directory -Force -Path $modelsOut | Out-Null

Write-Host "== 1/6 准备便携 Node（v$NodeVersion，随包发布免安装时下载） =="
$nodeZip = Join-Path $Out ".tmp-node.zip"
$nodeUrl = "https://nodejs.org/dist/v${NodeVersion}/node-v${NodeVersion}-win-x64.zip"
if (-not (Test-Path $nodeZip)) {
  Write-Host "下载 $nodeUrl ..."
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing -TimeoutSec 900
}
Expand-Archive -Path $nodeZip -DestinationPath $nodeOut -Force

Write-Host "== 2/6 拷贝 + 裁剪 node_modules（源: $ZvecSrc） =="
$nmSrc = Join-Path $ZvecSrc "node_modules"
$nmDst = Join-Path $zgOut "node_modules"
# 注意：不能删 *.wasm —— web-tree-sitter/tree-sitter.wasm 是代码符号解析的必需资产
robocopy $nmSrc $nmDst /E /XD "@node-llama-cpp" "onnxruntime-web" "@img" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy node_modules 失败 (exit $LASTEXITCODE)" }

# onnxruntime-node 仅保留 win32
$onnxBin = Join-Path $nmDst "onnxruntime-node\bin\napi-v3"
foreach ($p in @("linux", "darwin")) {
  $target = Join-Path $onnxBin $p
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
}

Write-Host "== 3/6 拷贝 dist + package.json =="
Copy-Item (Join-Path $ZvecSrc "dist") (Join-Path $zgOut "dist") -Recurse -Force
Copy-Item (Join-Path $ZvecSrc "package.json") (Join-Path $zgOut "package.json")

Write-Host "== 4/6 拷贝默认模型缓存（potion-code-16m-v2） =="
robocopy (Join-Path $ModelCache "model2vec") (Join-Path $modelsOut "model2vec") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy models 失败 (exit $LASTEXITCODE)" }

Write-Host "== 5/6 冒烟：裁剪后 CLI 可加载 + 包内 node 可用 =="
$cli = Join-Path $zgOut "dist\cli\index.js"
$smoke = & node $cli version 2>&1
Write-Host "zg smoke: $smoke"
if ($LASTEXITCODE -ne 0) { throw "冒烟失败：裁剪破坏运行链（$smoke）" }
$pkgNode = Get-ChildItem $nodeOut -Recurse -Filter "node.exe" | Select-Object -First 1
if (-not $pkgNode) { throw "便携 node 未就位" }
$nodeSmoke = & $pkgNode.FullName --version 2>&1
Write-Host "node smoke: $nodeSmoke ($($pkgNode.FullName))"

Write-Host "== 6/6 打包（单合并包：Node+运行时+模型） =="
$packZip = Join-Path $Out "codem-zvec-win-x64.zip"
if (Test-Path $packZip) { Remove-Item -Force $packZip }
Push-Location (Join-Path $staging "zvec")
tar -a -c -f $packZip .
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "tar pack zip 失败" }

# 清理 staging
Remove-Item -Recurse -Force $staging

$pz = (Get-Item $packZip).Length
Write-Host ("完成: {0} ({1:N1} MB)" -f $packZip, ($pz / 1MB))
Write-Host "上传到 GitHub Release 后用市场卡片验证：在线一键安装（含 Node，免外部 node 下载）/ 离线单包导入 + 项目建索引。"

