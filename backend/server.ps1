# Streak tracker server: serves ../frontend and a small JSON API.
# Usage: powershell -ExecutionPolicy Bypass -File backend\server.ps1 [-Port 8080]
param([int]$Port = 8080)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer

$backend = $PSScriptRoot
$frontend = [IO.Path]::GetFullPath((Join-Path $backend '..\frontend'))
$configFile = Join-Path $backend 'config.json'
$dataDir = Join-Path $backend 'data'
$dataFile = Join-Path $dataDir 'entries.json'

if (-not (Test-Path $configFile)) {
  Write-Host 'Missing backend\config.json. Copy backend\config.example.json to backend\config.json and set your login.' -ForegroundColor Red
  exit 1
}
$config = $json.DeserializeObject([IO.File]::ReadAllText($configFile))
if (-not $config['username'] -or -not $config['password']) {
  Write-Host 'backend\config.json needs both "username" and "password".' -ForegroundColor Red
  exit 1
}

# First day that can be tracked; days before it (and future days) can't be updated
$startDate = if ($config['startDate']) { [string]$config['startDate'] } else { (Get-Date).ToString('yyyy-MM-dd') }
$parsedStart = [datetime]::MinValue
if (-not [datetime]::TryParseExact($startDate, 'yyyy-MM-dd', $null, 'None', [ref]$parsedStart)) {
  Write-Host 'backend\config.json "startDate" must look like 2026-10-24.' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory $dataDir | Out-Null }
if (Test-Path $dataFile) {
  $entries = $json.DeserializeObject([IO.File]::ReadAllText($dataFile))
} else {
  $entries = [System.Collections.Generic.Dictionary[string,object]]::new()
}

$sessions = @{}  # token -> expiry
$sessionDays = 7
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider

function New-Token {
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  [BitConverter]::ToString($bytes).Replace('-', '').ToLower()
}

function Save-Entries {
  $tmp = "$dataFile.tmp"
  [IO.File]::WriteAllText($tmp, $json.Serialize($entries))
  Move-Item -Force $tmp $dataFile
}

function Send-Json($res, [int]$status, $body) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json.Serialize($body))
  $res.StatusCode = $status
  $res.ContentType = 'application/json; charset=utf-8'
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Read-Body($req) {
  if ($req.ContentLength64 -gt 10KB) { throw 'Body too large' }
  $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  if (-not $text) { return @{} }
  $json.DeserializeObject($text)
}

function Get-Session($req) {
  $cookie = $req.Cookies['sid']
  if (-not $cookie) { return $null }
  $expiry = $sessions[$cookie.Value]
  if (-not $expiry) { return $null }
  if ($expiry -lt (Get-Date)) { $sessions.Remove($cookie.Value); return $null }
  $cookie.Value
}

function Handle-Api($req, $res, [string]$path) {
  $method = $req.HttpMethod

  if ($path -eq '/api/login' -and $method -eq 'POST') {
    $body = Read-Body $req
    if ($body['username'] -ceq $config['username'] -and $body['password'] -ceq $config['password']) {
      $token = New-Token
      $sessions[$token] = (Get-Date).AddDays($sessionDays)
      $res.AppendHeader('Set-Cookie', "sid=$token; Path=/; HttpOnly; SameSite=Strict; Max-Age=$($sessionDays * 86400)")
      Send-Json $res 200 @{ username = $config['username']; startDate = $startDate }
    } else {
      Start-Sleep -Milliseconds 600  # slow down guessing
      Send-Json $res 401 @{ error = 'Wrong login ID or password' }
    }
    return
  }

  $token = Get-Session $req

  if ($path -eq '/api/session' -and $method -eq 'GET') {
    if ($token) { Send-Json $res 200 @{ loggedIn = $true; username = $config['username']; startDate = $startDate } }
    else { Send-Json $res 200 @{ loggedIn = $false } }
    return
  }

  if (-not $token) { Send-Json $res 401 @{ error = 'Not logged in' }; return }

  if ($path -eq '/api/logout' -and $method -eq 'POST') {
    $sessions.Remove($token)
    $res.AppendHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    Send-Json $res 200 @{ ok = $true }
    return
  }

  if ($path -eq '/api/entries' -and $method -eq 'GET') {
    Send-Json $res 200 $entries
    return
  }

  if ($path -match '^/api/entries/(\d{4}-\d{2}-\d{2})(/lock)?$') {
    $date = $Matches[1]
    $isLock = [bool]$Matches[2]
    $parsed = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($date, 'yyyy-MM-dd', $null, 'None', [ref]$parsed)) {
      Send-Json $res 400 @{ error = 'Invalid date' }; return
    }
    $today = (Get-Date).ToString('yyyy-MM-dd')
    if ($date -lt $startDate -or $date -gt $today) {
      Send-Json $res 400 @{ error = "Only days from $startDate to today can be updated" }; return
    }
    $existing = if ($entries.ContainsKey($date)) { $entries[$date] } else { $null }
    if ($existing -and $existing.ContainsKey('locked') -and $existing['locked']) {
      Send-Json $res 409 @{ error = 'This day is locked and can no longer be changed' }; return
    }

    # Locking is separate from saving, and only allowed once the day is over
    if ($isLock) {
      if ($method -ne 'POST') { Send-Json $res 405 @{ error = 'Use POST to lock' }; return }
      if (-not $existing) { Send-Json $res 400 @{ error = 'Update this day before locking it' }; return }
      if ($date -ge $today) { Send-Json $res 400 @{ error = 'A day can only be locked after it is over' }; return }
      $existing['locked'] = $true
      Save-Entries
      Send-Json $res 200 $existing
      return
    }

    if ($method -ne 'PUT') { Send-Json $res 405 @{ error = 'Use PUT to update' }; return }
    $body = Read-Body $req
    $entry = [System.Collections.Generic.Dictionary[string,object]]::new()
    if ($body['kept'] -eq $true) {
      $entry['kept'] = $true
    } elseif ($body['kept'] -eq $false) {
      $count = 0
      if (-not [int]::TryParse([string]$body['count'], [ref]$count) -or $count -lt 1 -or $count -gt 99) {
        Send-Json $res 400 @{ error = 'Count must be between 1 and 99' }; return
      }
      $entry['kept'] = $false
      $entry['count'] = $count
    } else {
      Send-Json $res 400 @{ error = '"kept" must be true or false' }; return
    }
    $entries[$date] = $entry
    Save-Entries
    Send-Json $res 200 $entry
    return
  }

  Send-Json $res 404 @{ error = 'Not found' }
}

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.json' = 'application/json'
}

function Handle-Static($req, $res, [string]$path) {
  $rel = $path.TrimStart('/')
  if ($rel -eq '') { $rel = 'index.html' }
  $file = [IO.Path]::GetFullPath((Join-Path $frontend $rel))
  if ($file.StartsWith($frontend + [IO.Path]::DirectorySeparatorChar) -and (Test-Path $file -PathType Leaf)) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file)
    $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Streak running at http://localhost:$Port/ (Ctrl+C to stop)" -ForegroundColor Green

try {
  while ($listener.IsListening) {
    # Poll so Ctrl+C can interrupt between requests
    $pending = $listener.GetContextAsync()
    while (-not $pending.AsyncWaitHandle.WaitOne(250)) {}
    $ctx = $pending.GetAwaiter().GetResult()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.AbsolutePath
    try {
      if ($path.StartsWith('/api/')) { Handle-Api $req $res $path }
      else { Handle-Static $req $res $path }
    } catch {
      Write-Host "Error: $_" -ForegroundColor Red
      try { Send-Json $res 500 @{ error = 'Server error' } } catch {}
    }
    $res.Close()
    Write-Host "$($req.HttpMethod) $path -> $($res.StatusCode)"
  }
} finally {
  $listener.Stop()
}
