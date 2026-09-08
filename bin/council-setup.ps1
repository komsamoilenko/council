# Owns the PowerShell installer launcher; specification 7.1.
$councilNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $councilNode) {
  [Console]::Error.WriteLine('Node not found: install Node LTS from https://nodejs.org/en/download (or winget install --exact --id OpenJS.NodeJS.LTS --source winget), then re-run')
  exit 2
}
& $councilNode.Source (Join-Path $PSScriptRoot '..\installer\setup.mjs') @args
exit $LASTEXITCODE
