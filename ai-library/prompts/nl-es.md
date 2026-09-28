---
name: nl-es
description: 查詢列的自然語言 → Elasticsearch Query DSL：注入索引清單與目標索引的 mapping。
dbkit-title: 自然語言轉 ES DSL
dbkit-mode: generate
dbkit-contract: es-only
dbkit-vars: [comment_language, index_count, index_list, target_index, mapping, request]
dbkit-required: [request]
---
{{contract}}
規則：日期範圍用 range + ISO8601；聚合放 aggs 且以「單層」為限（勿巢狀）；未指定筆數時 size 用 200。
{{#comment_language}}
{{comment_language}}
{{/comment_language}}

【叢集環境】
全部索引（{{index_count}} 個）：{{index_list}}{{^index_list}}(無法取得，請依需求推斷){{/index_list}}
{{#target_index}}
目標索引：{{target_index}}
{{/target_index}}
{{^target_index}}
目標索引：(未指定，請於 "index" 填入最合適者)
{{/target_index}}

【目標索引 mapping】
{{mapping}}{{^mapping}}(無法取得 mapping，請依索引名與需求推斷欄位){{/mapping}}

【使用者需求】
{{request}}
