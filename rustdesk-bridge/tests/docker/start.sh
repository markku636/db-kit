#!/bin/sh
# Xvfb 當螢幕、xterm 當畫面內容，RustDesk 以 server 模式跑，再設固定密碼。
# 有 RD_SERVER 時改用自架的 ID / 中繼伺服器（compose.yml）：RD_KEY 或 RD_KEY_FILE（等 hbbs 產生公鑰檔）給 Key。
CFG=/root/.config/rustdesk/RustDesk2.toml
if [ -n "$RD_SERVER" ]; then
  if [ -z "$RD_KEY" ] && [ -n "$RD_KEY_FILE" ]; then
    i=0
    while [ ! -s "$RD_KEY_FILE" ] && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
    RD_KEY=$(cat "$RD_KEY_FILE")
  fi
  printf "custom-rendezvous-server = '%s'\nrelay-server = '%s'\nkey = '%s'\n" "$RD_SERVER" "${RD_RELAY:-$RD_SERVER}" "$RD_KEY" >> "$CFG"
fi
Xvfb :0 -screen 0 1024x768x24 &
export DISPLAY=:0
sleep 1
xterm -geometry 80x24+10+10 &
rustdesk --server &
sleep 5
rustdesk --password dbkit123 || true
wait
