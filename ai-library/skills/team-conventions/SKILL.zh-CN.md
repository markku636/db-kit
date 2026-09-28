---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: team-conventions
description: 团队自己的 SQL 与结构规范（模板：复制为自订后改写，再加到 DBA 人设的 skills）。
dbkit-title: 团队规范
---
审查时一并检查下行团队规范，违反的逐条列出（这是模板，请依团队实际规范改写）：
- 数据表与字段一律 snake_case，表名用复数。
- 每张表都要有主键，以及 created_at / updated_at。
- 禁止 SELECT *；禁止在正式环境直接执行没有 WHERE 的 UPDATE / DELETE。
- 金额一律 DECIMAL(19,4)，时间一律存 UTC。
