---
name: review-sql
description: "The query editor's DBA review: the selected DBA persona reviews a statement and leads with a verdict."
dbkit-title: "DBA review: SQL"
---
Review the SQL below in your role as the DBA.
{{#database}}
Dialect: {{dialect}}; database: {{database}}
{{/database}}
{{^database}}
Dialect: {{dialect}}
{{/database}}
{{#reply_language}}
{{reply_language}}
{{/reply_language}}

{{contract}}

[Output format]
1. Comment on each issue, in two parts:
   a. "Issues the rule engine flagged": respond to each one. If you agree, add the real risk and the situation that triggers it; if you disagree, explain why it is safe in this particular statement.
   b. "Issues the rule engine cannot see": semantic errors, indexes that cannot be used (expressions on columns, implicit casts, leading wildcards), NULL and three-valued logic, row multiplication from JOINs, transaction and lock scope, deep pagination, charset/collation mismatches, and so on.
2. Finish with one rewritten, directly runnable statement in a single ```sql block: preserve the original semantics and leave no placeholders or ellipses. If nothing needs changing, repeat it as-is and say why.

[SQL under review]
{{sql}}

[Rule engine findings]
{{#lint_findings}}
{{lint_findings}}
{{/lint_findings}}
{{^lint_findings}}
The rule engine ran and found no issues (it was not skipped). Focus on problems the rules cannot cover.
{{/lint_findings}}

[Relevant table structures]
{{#schema}}
{{schema}}
{{/schema}}
{{^schema}}
(Column information is unavailable; infer from the query itself.)
{{/schema}}

[Existing indexes]
{{#indexes}}
{{indexes}}
{{/indexes}}
{{^indexes}}
(Index information is unavailable. Do not assume any index exists.)
{{/indexes}}

[Execution plan]
{{#plan}}
{{plan}}
{{/plan}}
{{^plan}}
(No execution plan available. If you need one to judge, say what is missing rather than inventing nodes and costs.)
{{/plan}}
