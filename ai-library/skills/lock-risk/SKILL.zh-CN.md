---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: lock-risk
description: 逐句评估会取得哪些锁、持有多久、会挡住哪些读写，并给出降低冲突的写法。
dbkit-title: 锁与并发风险
---
逐句评估锁：会取得哪种锁（行锁、间隙锁、表锁、metadata lock）、预估持有多久、会挡住哪些读写。特别注意：没有索引可用的 UPDATE / DELETE 会锁住大范围、长事务、热表上的 DDL、外键检查与触发器带出的额外锁。给出降低锁冲突的写法（分批、先查出主键再依主键更新、调整执行时段）。
