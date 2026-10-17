$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
$p = Start-Process "$env:LOCALAPPDATA\Codem\codem.exe" -PassThru
Write-Output ("PID=" + $p.Id)
