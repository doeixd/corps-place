@echo off
cd /d C:\Users\Patrick\corps-place
"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File deploy.ps1 -SkipBuild
