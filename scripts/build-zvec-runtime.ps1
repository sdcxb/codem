# ============================================================
# build-zvec-runtime.ps1 — 构建 zvec-grep 发布产物（单合并包：运行时 + 模型）
#
# 产出（Release 时随 tag 上传，供市场卡片「一键安装」与「离线包导入」）：
#   codem-zvec-win-x64.zip —— 解压到 <runtime 根> 后即得：
#       runtime/zg/…   zg 裁剪运行时（dist + 精简 node_modules）
#       models/…       potion-code-16m-v2 模型缓存（MIT，可再分发）
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
$zgOut = Join-Path $staging "zvec\runtime\zg"
$modelsOut = Join-Path $staging "zvec\models"
New-Item -ItemType Directory -Force -Path $zgOut | Out-Null
New-Item -ItemType Directory -Force -Path $modelsOut | Out-Null

Write-Host "== 1/5 拷贝 + 裁剪 node_modules（源: $ZvecSrc） =="
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

Write-Host "== 2/5 拷贝 dist + package.json =="
Copy-Item (Join-Path $ZvecSrc "dist") (Join-Path $zgOut "dist") -Recurse -Force
Copy-Item (Join-Path $ZvecSrc "package.json") (Join-Path $zgOut "package.json")

Write-Host "== 3/5 拷贝默认模型缓存（potion-code-16m-v2） =="
robocopy (Join-Path $ModelCache "model2vec") (Join-Path $modelsOut "model2vec") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy models 失败 (exit $LASTEXITCODE)" }

Write-Host "== 4/5 冒烟：裁剪后 CLI 可加载 =="
$cli = Join-Path $zgOut "dist\cli\index.js"
$smoke = & node $cli version 2>&1
Write-Host "smoke: $smoke"
if ($LASTEXITCODE -ne 0) { throw "冒烟失败：裁剪破坏运行链（$smoke）" }

Write-Host "== 5/5 打包（单合并包） =="
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
Write-Host "上传到 GitHub Release 后用市场卡片验证：在线一键安装 / 离线单包导入 + 项目建索引。"

