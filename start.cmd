@echo off
rem Starts the Melvor Idle self-host server. Open http://<this machine>:8787 in a browser.
cd /d "%~dp0"
node server.js
