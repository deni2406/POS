@echo off
echo Memulai PM2 Server POS & Admin...
cd /d C:\pos
pm2 start server.js --name "pollarbilliard-pos"
pm2 start admin/admin-server.js --name "admin-server"
pm2 save
pm2 status
pause