# One-time setup for ccgram-poller's browser mode (see README.md next to this file).
# Run it ON THE BRIDGE MACHINE, in a normal PowerShell window:
#   powershell -ExecutionPolicy Bypass -File .\bridge\browser\setup.ps1
# Site addresses and credentials stay in two local files - never in git or the chat.
param(
  [string]$BrowserHome = 'C:\claude-browser',
  [string]$Workspace = 'C:\websites\browser'
)
$ErrorActionPreference = 'Stop'
$bridge = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false

Write-Host '1/4  Installing Playwright MCP...'
Push-Location $bridge
try { npm install --no-audit --no-fund } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Write-Host '2/4  Creating folders...'
New-Item -ItemType Directory -Force (Join-Path $BrowserHome 'profile'), (Join-Path $BrowserHome 'out'), $Workspace | Out-Null

$secrets = Join-Path $BrowserHome 'secrets.env'
if (-not (Test-Path $secrets)) {
  [System.IO.File]::WriteAllText($secrets, @'
# Credentials the browser types for Claude, one NAME=value per line.
# Claude only ever writes the NAME; Playwright MCP types the value and hides it
# from everything it sends back. Use the same names in CLAUDE.md in the workspace.
MEMBER_ID=
SITE_PIN=
'@, $utf8)
}

$notes = Join-Path $Workspace 'CLAUDE.md'
if (-not (Test-Path $notes)) {
  [System.IO.File]::WriteAllText($notes, @"
# Sites for the browser workspace

This file is local to this machine (not in git). Every browser prompt runs in this
folder, so Claude reads it each time. Credentials are secret NAMES from
$secrets - type the name, never ask for the value.

## Site 1 - (name)
- Address: https://
- Login: ID number (type MEMBER_ID), then the site texts a code to the owner - ask for it.
- Usual tasks:

## Site 2 - (name)
- Address: https://
- Login: 5-digit PIN (type SITE_PIN). One attempt only; if it is rejected, tell the owner.
- Usual tasks:
"@, $utf8)
}

Write-Host '3/4  Fill in both files that open (credentials, site addresses), save them and close Notepad.'
Start-Process notepad $secrets
Start-Process notepad $notes
Read-Host 'Press Enter when both files are saved'

Write-Host '4/4  Opening Chrome and running one browser prompt...'
$env:PROJECT_DIRS = Split-Path -Parent $Workspace
$env:BROWSER_HOME = $BrowserHome
node (Join-Path $bridge 'ccgram-poller.mjs') --browser-check
if ($LASTEXITCODE -ne 0) { throw 'Browser check failed - see the message above.' }

Write-Host ''
Write-Host 'Done. Restart the poller (close its window, run the CCGram-Poller shortcut) so it loads browser mode.'
Write-Host "Then in /admin/claude-bot choose workspace 'browser' and say what to do."
