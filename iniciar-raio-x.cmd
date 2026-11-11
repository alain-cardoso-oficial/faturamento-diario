@echo off
cd /d "%~dp0"
start "Raio X D-1" http://localhost:8788
node raio-x\server-v2.js
