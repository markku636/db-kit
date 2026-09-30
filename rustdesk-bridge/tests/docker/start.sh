#!/bin/sh
# Xvfb 當螢幕、xterm 當畫面內容，RustDesk 以 server 模式跑，再設固定密碼。
Xvfb :0 -screen 0 1024x768x24 &
export DISPLAY=:0
sleep 1
xterm -geometry 80x24+10+10 &
rustdesk --server &
sleep 5
rustdesk --password dbkit123 || true
wait
