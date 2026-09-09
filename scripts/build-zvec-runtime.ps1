# ============================================================
# build-zvec-runtime.ps1 — 构建 zvec-grep 发布产物（裁剪运行时 + 模型包）
#
# 产出（Release 时随 tag 上传，供市场卡片「一键安装」与「离线包导入」）：
#   codem-zvec-runtime-win-x64.zip   —— zg 裁剪运行时（解压到 <runtime>/zg）
#   codem-zvec-models-potion-code16.zip —— potion-code-16m-v2 模型缓存（解压到 <runtime>/models）
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
New-Item -ItemType Directory -Force -Path (Join-Path $staging "zg") | Out-Null

Write-Host "== 1/4 拷贝 + 裁剪 node_modules（源: $ZvecSrc） =="
$nmSrc = Join-Path $ZvecSrc "node_modules"
$nmDst = Join-Path $staging "zg\node_modules"
robocopy $nmSrc $nmDst /E /XD "@node-llama-cpp" "onnxruntime-web" "@img" /XF "*.wasm" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy node_modules 失败 (exit $LASTEXITCODE)" }

# onnxruntime-node 仅保留 win32
$onnxBin = Join-Path $nmDst "onnxruntime-node\bin\napi-v3"
foreach ($p in @("linux", "darwin")) {
  $target = Join-Path $onnxBin $p
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
}

Write-Host "== 2/4 拷贝 dist + package.json =="
Copy-Item (Join-Path $ZvecSrc "dist") (Join-Path $staging "zg\dist") -Recurse -Force
Copy-Item (Join-Path $ZvecSrc "package.json") (Join-Path $staging "zg\package.json")

Write-Host "== 3/4 冒烟：裁剪后 CLI 可加载 =="
$nodeExe = "node"
$smoke = & $nodeExe (Join-Path $staging "zg\dist\cli\index.js") version 2>&1
Write-Host "smoke: $smoke"
if ($LASTEXITCODE -ne 0) { throw "冒烟失败：裁剪破坏运行链（$smoke）" }

Write-Host "== 4/4 打包 =="
$runtimeZip = Join-Path $Out "codem-zvec-runtime-win-x64.zip"
$modelsZip = Join-Path $Out "codem-zvec-models-potion-code16.zip"
if (Test-Path $runtimeZip) { Remove-Item -Force $runtimeZip }
if (Test-Path $modelsZip) { Remove-Item -Force $modelsZip }

# runtime zip：内容为 zg/ 下文件（解压到 runtime/zg）
Push-Location (Join-Path $staging "zg")
tar -a -c -f $runtimeZip .
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "tar runtime zip 失败" }

# models zip：内容为 model2vec/...（解压到 runtime/models）
Push-Location $ModelCache
tar -a -c -f $modelsZip model2vec
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "tar models zip 失败" }

# 清理 staging
Remove-Item -Recurse -Force $staging

$rz = (Get-Item $runtimeZip).Length
$mz = (Get-Item $modelsZip).Length
Write-Host ("完成: {0} ({1:N1} MB)" -f $runtimeZip, ($rz / 1MB))
Write-Host ("完成: {0} ({1:N1} MB)" -f $modelsZip, ($mz / 1MB))
Write-Host "上传到 GitHub Release 后用市场卡片验证：在线一键安装 + 项目建索引。"
