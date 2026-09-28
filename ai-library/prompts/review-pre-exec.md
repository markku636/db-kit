---
name: review-pre-exec
description: Pre-execution review for Review & run and `dbk run`. Rendered by the backend so the GUI and the CLI always send the same prompt.
dbkit-title: DBA review before execution
dbkit-lang: en
dbkit-mode: dba
dbkit-contract: verdict
dbkit-vars: [engine, connection, database, production, reply_language_name, capture_limit, script, static_analysis, tables, samples]
dbkit-required: [script, static_analysis]
---
Review the SQL script below as the database administrator, BEFORE it is executed against a {{engine}} database.
{{#production}}
This is a PRODUCTION connection. Be strict.
{{/production}}
Reply in {{reply_language_name}}. Be concise and concrete; refer to statements by number (#1, #2, …).

{{contract}}

Then write these Markdown sections:
## Summary
## Expected changes (before → after)
For every write statement: which rows or objects change and how, using the row estimates below.
## Risks
Locks and long-running operations, missing or overly broad WHERE clauses, constraint / trigger / cascade side effects, data loss, ordering problems between statements.
## Suggested fixes
Only if needed. Put corrected SQL in fenced code blocks.
## Rollback check
The tool will capture before-images and generate a rollback script as described per statement below. Point out what that rollback does NOT cover.

Do not invent tables or columns that are not listed. If information is missing, say what is missing instead of guessing.

# Context
- Engine: {{engine}}
- Connection: {{connection}}
- Current database / schema: {{database}}
- Production: {{#production}}yes{{/production}}{{^production}}no{{/production}}
- Execution: statements run one at a time with autocommit (no wrapping transaction); execution stops at the first error.
- Before-image capture limit: {{capture_limit}} rows per statement.

# Script
{{script}}

# Static analysis
{{static_analysis}}
{{#tables}}

# Tables
{{tables}}
{{/tables}}
{{#samples}}

# Sample rows (current state, before execution)
{{samples}}
{{/samples}}
