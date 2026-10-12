param(
  [Parameter(Mandatory=$true)][int]$TopicId,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$MaxPosts = 12
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }
$resp = Invoke-WebRequest -Uri "https://forum.trae.cn/t/topic/$TopicId.json" -Headers $headers -UseBasicParsing -TimeoutSec 40
$j = $resp.Content | ConvertFrom-Json
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("URL: https://forum.trae.cn/t/topic/$TopicId")
[void]$sb.AppendLine("TITLE: $($j.title)")
[void]$sb.AppendLine("CREATED: $($j.created_at)  POSTS: $($j.posts_count)  VIEWS: $($j.views)")
[void]$sb.AppendLine("=====")
$n = 0
foreach ($p in $j.post_stream.posts) {
  if ($n -ge $MaxPosts) { break }
  $n++
  $t = [string]$p.cooked
  $t = [regex]::Replace($t, '(?is)<(script|style)[^>]*>.*?</\1>', ' ')
  $t = [regex]::Replace($t, '(?i)</(p|div|li|br|h1|h2|h3|blockquote|pre)\s*>', "`n")
  $t = [regex]::Replace($t, '(?s)<[^>]+>', ' ')
  $t = [System.Net.WebUtility]::HtmlDecode($t)
  $t = [regex]::Replace($t, '[ \t\u00A0]+', ' ')
  $t = [regex]::Replace($t, '(\s*\n\s*){2,}', "`n")
  [void]$sb.AppendLine("--- #$($p.post_number) by $($p.username) ($($p.created_at)) ---")
  [void]$sb.AppendLine($t.Trim())
}
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Set-Content -Path $Out -Value $sb.ToString() -Encoding UTF8
"OK -> $Out"
