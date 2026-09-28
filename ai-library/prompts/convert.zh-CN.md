---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: convert
description: 编辑器动作：把 SQL 改写成另一个方言；转不过去的留 -- TODO。
dbkit-title: 转换方言
---
你是数据库迁移专家，请把下面这段 {{dialect}} 的 SQL 改写成 {{target_dialect}} 可以执行的语句。
{{#database}}
方言：{{dialect}}；数据库：{{database}}
{{/database}}
{{^database}}
方言：{{dialect}}
{{/database}}
{{#reply_language}}
{{reply_language}}
{{/reply_language}}
目标方言：{{target_dialect}}

{{contract}}

【转换原则】
1. 逐项对应，不是逐字翻译。数据类型（tinyint(1) / boolean / bit、datetime / timestamptz / datetime2 / date、varchar / nvarchar / varchar2、decimal / number）与内置函数（字符串串接、日期加减与格式化、NULL 处理的 IFNULL / COALESCE / NVL / ISNULL）都要换成目标方言真的有的东西。
2. 识别字引号换成目标方言的写法：MySQL / MariaDB 用反引号、PostgreSQL 与 Oracle 用双引号、SQL Server 用中括号。顺带注意大小写规则——Oracle 未加引号的识别字会折成大写、PostgreSQL 会折成小写，一旦加上引号就等于把大小写锁死。
3. 分页语法要换：LIMIT n OFFSET m（MySQL / MariaDB / PostgreSQL / SQLite）、TOP n 或 OFFSET m ROWS FETCH NEXT n ROWS ONLY（SQL Server）、FETCH FIRST n ROWS ONLY（Oracle 12c 以后）。FETCH 系列必须搭配 ORDER BY，否则结果不稳定。
4. 其他常见落差：自动递增（AUTO_INCREMENT / SERIAL / IDENTITY / 序列）、UPSERT（ON DUPLICATE KEY UPDATE / ON CONFLICT / MERGE）、布尔值表示法、字符串串接操作符（CONCAT / || / +）、日期字面值与空字符串和 NULL 的关系（Oracle 视两者相同）。
5. 真的转不过去的东西，就写成 -- TODO: 注解说明差异与建议做法，不要静静猜一个看起来像的写法。看起来能跑、语义却不同的替代品会被直接执行，代价远高于一行摆在眼前的 TODO。

【待转换 SQL】
{{sql}}

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
