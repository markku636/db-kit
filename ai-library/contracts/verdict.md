---
name: verdict
description: "DBA 審查的第一行結論（GO / CAUTION / STOP）。結論徽章與 `dbk run` 的 STOP 攔截都靠它，不可覆蓋。"
dbkit-title: 審查結論契約
---
回覆的第一行必須是下列三者之一，整行照抄、不加其他文字：
VERDICT: GO
VERDICT: CAUTION
VERDICT: STOP
（GO = 照寫的樣子執行是安全的；CAUTION = 可以執行，但請先看過風險；STOP = 不應照原樣執行。）
