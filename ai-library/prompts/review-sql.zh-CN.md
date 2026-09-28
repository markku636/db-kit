---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: review-sql
description: 查询编辑器的「DBA 审查」：以选定的 DBA 人设审查一段 SQL，第一行给结论。
dbkit-title: DBA 审查 SQL
---
请以你的 DBA 身分审查下面这段 SQL。
{{#database}}
方言：{{dialect}}；数据库：{{database}}
{{/database}}
{{^database}}
方言：{{dialect}}
{{/database}}
{{#reply_language}}
{{reply_language}}
{{/reply_language}}

{{contract}}

【输出格式】
1. 逐条点评，分成两段：
   a.「规则引擎已标出的问题」：逐条回应。同意就补上实际风险与会踩到的情境；不同意就讲清楚为什么在这段 SQL 里是安全的。
   b.「规则引擎看不出来的问题」：语义错误、索引用不上（字段加工、隐式类型转换、前缀通配符）、NULL 与三值逻辑、JOIN 造成的行数放大、事务与锁的范围、深分页、字符集与排序规则不一致等。
2. 最后给一段改写后、可直接执行的 SQL，放进单一 ```sql 区块：保持原本语义，不要留占位符或省略号。若没有需要改的地方，就附上原样并说明理由。

【待审 SQL】
{{sql}}

【规则引擎发现】
{{#lint_findings}}
{{lint_findings}}
{{/lint_findings}}
{{^lint_findings}}
规则引擎已检查，没有发现问题（不是没有执行）。请把重点放在规则涵盖不到的问题。
{{/lint_findings}}

【相关数据表结构】
{{#schema}}
{{schema}}
{{/schema}}
{{^schema}}
(无法取得字段信息，请依查询内容推断。)
{{/schema}}

【现有索引】
{{#indexes}}
{{indexes}}
{{/indexes}}
{{^indexes}}
(无法取得索引信息。请勿假设任何索引存在。)
{{/indexes}}

【执行计划】
{{#plan}}
{{plan}}
{{/plan}}
{{^plan}}
(未取得执行计划。需要计划才能判断时，请直接说还缺什么，不要杜撰节点与成本。)
{{/plan}}
