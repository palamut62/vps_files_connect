#!/bin/bash

echo "🚀 VPS File Manager'ı Başlatıyor..."

# Backend'i arka planda başlat
echo "⚙️ Backend (Go) başlatılıyor..."
cd backend || exit
go run main.go &
BACKEND_PID=$!
cd ..

# Frontend'i başlat (bu süreç ön planda çalışacak ve Electron penceresi açılacak)
echo "🖥️ Frontend (Electron) başlatılıyor..."
cd frontend || exit
npm start
cd ..

# Electron kapatıldığında (npm start süreci bittiğinde) backend'i de kapat
echo "🛑 Uygulama kapatıldı. Backend sonlandırılıyor..."
kill $BACKEND_PID
