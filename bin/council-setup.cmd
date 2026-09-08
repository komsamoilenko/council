@echo off
rem Owns the Restricted-policy-compatible installer launcher; specification 7.1.
setlocal
for %%N in (node.exe) do set "COUNCIL_SETUP_NODE=%%~$PATH:N"
if not defined COUNCIL_SETUP_NODE (
  echo Node not found: install Node LTS from https://nodejs.org/en/download ^(or winget install --exact --id OpenJS.NodeJS.LTS --source winget^), then re-run 1>&2
  exit /b 2
)
"%COUNCIL_SETUP_NODE%" "%~dp0..\installer\setup.mjs" %*
exit /b %errorlevel%
