@echo off
chcp 65001 >nul
title MyWineCorks
echo.
echo  MyWineCorks — 連線位址 / Addresses
echo  ==================================
echo.
echo  這台電腦 / This computer:   http://localhost:3500
echo.
echo  其他電腦與手機 / Other computers and phones (same network):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do (
    echo     http://%%b:3500
    echo     手機（掃描、離線）/ Phones: https://%%b:5543/m
  )
)
echo.
echo  手機第一次使用 / Phone setup: http://localhost:3500/phone
echo.
pause