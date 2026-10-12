param(
  [Parameter(Mandatory=$true)][string]$Url,
  [Parameter(Mandatory=$true)][string]$Out
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$headers = @{
  "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  "Accept" = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
  "Accept-Language" = "zh-CN,zh;q=0.9,en;q=0.8"
}
$resp = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -TimeoutSec 40
$html = [string]$resp.Content

# strip scripts/styles/noscript/svg
$html = [regex]::Replace($html, '(?is)<script[^>]*>.*?</script>', ' ')
$html = [regex]::Replace($html, '(?is)<style[^>]*>.*?</style>', ' ')
$html = [regex]::Replace($html, '(?is)<noscript[^>]*>.*?</noscript>', ' ')
$html = [regex]::Replace($html, '(?is)<svg[^>]*>.*?</svg>', ' ')
$html = [regex]::Replace($html, '(?is)<head[^>]*>.*?</head>', ' ')
# block level -> newlines
$html = [regex]::Replace($html, '(?i)</(p|div|li|tr|h1|h2|h3|h4|h5|h6|section|article|pre|blockquote|table|ul|ol|header|footer|main|nav)\s*>', "`n")
$html = [regex]::Replace($html, '(?i)<br\s*/?>', "`n")
$html = [regex]::Replace($html, '(?i)</t[dh]\s*>', " | ")
$html = [regex]::Replace($html, '(?s)<[^>]+>', ' ')
$html = [System.Net.WebUtility]::HtmlDecode($html)
$html = $html -replace "`r", "`n"
$html = [regex]::Replace($html, '[ \t\u00A0]+', ' ')
$html = [regex]::Replace($html, '(\s*\n\s*){2,}', "`n")
$html = $html.Trim()

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$meta = "URL: $Url`nSTATUS: $($resp.StatusCode)`nTITLE-CHARS: $($html.Length)`n=====`n"
Set-Content -Path $Out -Value ($meta + $html) -Encoding UTF8
"OK -> $Out ($($html.Length) chars)"
