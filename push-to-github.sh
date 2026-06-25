#!/usr/bin/env bash
# 用法：先在 GitHub 建一個空 repo，然後：
#   ./push-to-github.sh git@github.com:你的帳號/db-kit.git
set -e
if [ -z "$1" ]; then
  echo "用法: ./push-to-github.sh <repo-url>"
  echo "例如: ./push-to-github.sh git@github.com:youruser/db-kit.git"
  exit 1
fi
git init
git add .
git commit -m "P0: 專案骨架 + 連線層 + MySQL 可連線"
git branch -M main
git remote add origin "$1"
git push -u origin main
echo "完成！已推送到 $1"
