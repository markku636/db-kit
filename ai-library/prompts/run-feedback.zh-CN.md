---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: run-feedback
description: 助手对话里「执行」之后回送给模型的结果。
dbkit-title: SQL 执行回馈
---
以下是刚才在 MAGIDB CONNECT 直接执行这段 SQL 的结果，请接续分析。

【已执行的 SQL】
{{sql}}

{{#failed}}
【错误消息】
{{error}}
{{/failed}}
{{^failed}}
【执行结果】
{{result}}
{{/failed}}

耗时：{{elapsed}}

【接下来】
{{#failed}}
请先说明这段 SQL 为什么失败（指出是语法、对象不存在、类型、权限还是数据问题），再给一段修正后、可直接执行的 SQL，放进单一 ```sql 区块：保持原本意图，不要留占位符或省略号。
{{/failed}}
{{^failed}}
请根据这份结果接续分析：数据代表什么、有没有异常或值得注意的趋势。若需要更多数据才能下结论，请直接给出下一段可执行的 SQL，放进单一 ```sql 区块，并说明那段查询要验证什么。
{{/failed}}
