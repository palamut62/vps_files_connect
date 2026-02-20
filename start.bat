@echo off
title VPS File Manager Baslatici
chcp 65001 > nul

echo =========================================
echo   VPS File Manager Baslatiliyor...
echo =========================================

echo ⚙️  Backend (Go) baslatiliyor...
cd backend
start "VPS Backend" cmd /c "go run main.go"
cd ..

echo 🖥️  Frontend (Electron) baslatiliyor...
cd frontend
call npm start
cd ..

echo 🛑 Frontend kapatildi.
pause
