---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: comment
description: 编辑器动作：只新增 -- 注解，SQL 本身一个字符都不动。
dbkit-title: 加上注解
---
你是资深数据库工程师，请替下面这段 SQL 加上注解。
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

【注解原则】
1. 只准新增 -- 注解行，SQL 本身一个字符都不能动：不改大小写、不改缩进、不改换行、不重排字段顺序。用户要的是「同一段 SQL 多了说明」，任何改写都会在 diff 里冒充成语义变更。
2. 语句最上方写一段总述：这段 SQL 的目的、参数的意义、预期返回什么。
3. 关键处逐段加注：JOIN 依据什么关联、不直观的过滤条件在挡什么、魔术数字与硬编码字符串的来历、聚合的口径（分母是什么、有没有去重）。
4. 显而易见的事不要写——「-- 选取字段」这种注解只是杂讯。写「为什么这样写」，不要写「这行做了什么」。
5. 不要用 /* */ 区块注解：嵌套支持各方言不一，贴回编辑器后可能把后面整段吃掉。

【待加注解的 SQL】
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
