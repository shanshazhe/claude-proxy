@echo off
setlocal
echo Open http://127.0.0.1:8082/login to sign in.
start /min node --use-system-ca "%~dp0proxy.js"
