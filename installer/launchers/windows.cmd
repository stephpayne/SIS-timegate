@echo off
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0windows.ps1" %*
