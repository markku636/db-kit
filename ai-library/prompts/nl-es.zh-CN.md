---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: nl-es
description: 查询行的自然语言 → Elasticsearch Query DSL：注入索引清单与目标索引的 mapping。
dbkit-title: 自然语言转 ES DSL
---
{{contract}}
规则：日期范围用 range + ISO8601；聚合放 aggs 且以「单层」为限（勿嵌套）；未指定条数时 size 用 200。
{{#comment_language}}
{{comment_language}}
{{/comment_language}}

【集群环境】
全部索引（{{index_count}} 个）：{{index_list}}{{^index_list}}(无法取得，请依需求推断){{/index_list}}
{{#target_index}}
目标索引：{{target_index}}
{{/target_index}}
{{^target_index}}
目标索引：(未指定，请于 "index" 填入最合适者)
{{/target_index}}

【目标索引 mapping】
{{mapping}}{{^mapping}}(无法取得 mapping，请依索引名与需求推断字段){{/mapping}}

【用户需求】
{{request}}
