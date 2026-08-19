# Codem 发布构建脚本 (PowerShell)
#
# 用法:
#   .\build-release.ps1              # 构建并签名
#   .\build-release.ps1 -Upload      # 构建并签名 + 上传到 GitHub Release
#
# 前提条件:
#   - .tauri\codem-updater.key 存在（私钥文件，不提交到 git）
#   - GitHub CLI (gh) 已登录
#
# 环境变量（可选，覆盖默认值）:
#   $env:TAURI_SIGNING_PRIVATE_KEY          # 密钥内容
#   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD # 密钥密码

param(
    [switch]$Upload,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

Write-Host "=== Codem Release Build ===" -ForegroundColor Cyan

# 1. 设置签名密钥环境变量
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $keyPath = ".tauri\codem-updater.key"
    if (Test-Path $keyPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
        Write-Host "[OK] Loaded private key from $keyPath" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Private key not found at $keyPath" -ForegroundColor Red
        Write-Host "        Run: npx tauri signer generate -p 'dummy' -w .tauri\codem-updater.key -f --ci" -ForegroundColor Yellow
        exit 1
    }
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
    Write-Host "[OK] Using default password" -ForegroundColor Green
}

# 2. 获取版本号
if (-not $Version) {
    $Version = (Get-Content package.json | ConvertFrom-Json).version
}
Write-Host "[INFO] Building version: $Version" -ForegroundColor Cyan

# 3. 构建
Write-Host "[INFO] Running tauri build..." -ForegroundColor Cyan
npx tauri build 2>&1 | Tee-Object -FilePath "build-$Version.log"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Build completed!" -ForegroundColor Green

# 4. 检查签名文件
$msiSig = "src-tauri\target\release\bundle\msi\Codem_${Version}_x64_en-US.msi.sig"
$nsisSig = "src-tauri\target\release\bundle\nsis\Codem_${Version}_x64-setup.exe.sig"

if ((Test-Path $msiSig) -and (Test-Path $nsisSig)) {
    Write-Host "[OK] Signature files generated!" -ForegroundColor Green
} else {
    Write-Host "[WARN] Signature files not found!" -ForegroundColor Yellow
}

# 5. 生成 latest.json
$nsisSigContent = Get-Content $nsisSig -Raw
$latestJson = @{
    version = $Version
    notes = "Codem v$Version"
    pub_date = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    platforms = @{
        windows = @{
            signature = $nsisSigContent.Trim()
            url = "https://github.com/sdcxb/codem/releases/download/v$Version/Codem_${Version}_x64-setup.exe"
        }
    }
} | ConvertTo-Json -Depth 5

$latestJsonPath = "src-tauri\target\release\latest.json"
Set-Content -Path $latestJsonPath -Value $latestJson -Encoding UTF8
Write-Host "[OK] Generated latest.json" -ForegroundColor Green

# 6. 上传到 GitHub Release
if ($Upload) {
    Write-Host "[INFO] Uploading to GitHub Release v$Version..." -ForegroundColor Cyan

    $msi = "src-tauri\target\release\bundle\msi\Codem_${Version}_x64_en-US.msi"
    $nsis = "src-tauri\target\release\bundle\nsis\Codem_${Version}_x64-setup.exe"

    gh release upload "v$Version" $msi $nsis $msiSig $nsisSig $latestJsonPath --clobber
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Upload failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Uploaded to GitHub Release v$Version!" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Build Summary ===" -ForegroundColor Cyan
Write-Host "Version:    $Version"
Write-Host "MSI:        $msi"
Write-Host "NSIS:       $nsis"
Write-Host "MSI Sig:    $msiSig"
Write-Host "NSIS Sig:   $nsisSig"
Write-Host "latest.json: $latestJsonPath"
if ($Upload) {
    Write-Host "Release:    https://github.com/sdcxb/codem/releases/tag/v$Version"
}
Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Green
