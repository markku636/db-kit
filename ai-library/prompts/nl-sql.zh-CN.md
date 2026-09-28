---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: nl-sql
description: 查询行的自然语言 → SQL：注入方言、表名清单与最相关表的字段。
dbkit-title: 自然语言转 SQL
---
{{contract}}
规则：方言为 {{dialect}}；优先使用下方结构中存在的表与字段；
{{#cross_dbs}}
可跨数据库查询：清单中带 `库.表` 的项目要原样以限定名参照（可用的库：{{cross_dbs}}）；
{{/cross_dbs}}
SELECT 无明确条数需求时加 LIMIT 200；除非用户明确要求，不生成 DDL。
{{#comment_language}}
{{comment_language}}
{{/comment_language}}

【数据库环境】
类型：{{dialect}}
数据库：{{database}}{{^database}}(默认){{/database}}
全部数据表（{{table_count}} 张）：{{table_list}}{{^table_list}}(无法取得，请依需求推断){{/table_list}}

【最相关数据表结构】
{{schema}}{{^schema}}(无法取得字段，请依表名与需求推断){{/schema}}

【用户需求】
{{request}}
