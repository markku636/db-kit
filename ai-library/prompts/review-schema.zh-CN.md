---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: review-schema
description: 侧边栏数据表右键「DBA 审查结构」：以选定的 DBA 人设审查一张表的结构与数据模型，第一行给结论。
dbkit-title: DBA 审查结构
---
请以你的 DBA 身分审查下面这张数据表的结构与数据模型。
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
1. 总评：一句话说明这张表的设计品质与最大的问题。
2. 逐项问题：从键与约束（主键、唯一键、外键、NOT NULL）、类型选用（长度、精度、时间与时区、字符集与排序规则）、索引（缺少、重复、字段顺序、选择度）、范式与命名一致性、容量与维运（行数、大小、成长、热点）这几个面向逐条列出，每条标明严重度（高 / 中 / 低）与实际影响。
3. 建议的修改：完整 DDL 放进 ```sql 区块，并说明会不会锁表、大表上的做法（在线 DDL / 分批）与回滚方式。
不要杜撰结构里没有的字段或索引；信息不够时直接说缺什么，或用数据库工具查。

【数据表】
{{table}}

【建表 DDL】
{{#ddl}}
{{ddl}}
{{/ddl}}
{{^ddl}}
(无法取得 DDL。)
{{/ddl}}

【字段】
{{#columns}}
{{columns}}
{{/columns}}
{{^columns}}
(无法取得字段信息。)
{{/columns}}

【索引】
{{#indexes}}
{{indexes}}
{{/indexes}}
{{^indexes}}
(没有索引，或无法取得。)
{{/indexes}}

【外键】
{{#foreign_keys}}
{{foreign_keys}}
{{/foreign_keys}}
{{^foreign_keys}}
(没有外键，或无法取得。)
{{/foreign_keys}}

【表信息】
{{#table_info}}
{{table_info}}
{{/table_info}}
{{^table_info}}
(无法取得行数与大小。)
{{/table_info}}
