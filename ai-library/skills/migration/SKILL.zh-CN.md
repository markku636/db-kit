---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: migration
description: 生成可回滚的迁移脚本（up / down），并标注锁表、分批与备份。
dbkit-title: 迁移脚本
---
生成可回滚的迁移：up 与 down 各一段，标注是否会锁表、数据量大时的分批做法，以及执行前的备份指令。
