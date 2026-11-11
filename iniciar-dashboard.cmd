@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
start "Black Friday BI" http://localhost:8787
npm start
