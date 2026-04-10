@echo off
:: Nexus CLI installer — double-click to install without manual ExecutionPolicy changes
powershell.exe -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
