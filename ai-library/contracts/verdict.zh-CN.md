---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: verdict
description: "DBA 审查的第一行结论（GO / CAUTION / STOP）。结论徽章与 `dbk run` 的 STOP 拦截都靠它，不可覆盖。"
dbkit-title: 审查结论契约
---
回复的第一行必须是下行三者之一，整行照抄、不加其他文字：
VERDICT: GO
VERDICT: CAUTION
VERDICT: STOP
（GO = 照写的样子执行是安全的；CAUTION = 可以执行，但请先看过风险；STOP = 不应照原样执行。）
