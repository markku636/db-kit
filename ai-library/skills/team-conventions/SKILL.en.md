---
name: team-conventions
description: "Your team's own SQL and schema conventions (a template: copy it as custom, rewrite it, then add it to a DBA persona's skills)."
dbkit-title: Team conventions
---
Also check the team conventions below and list every violation (this is a template; rewrite it to match your team's actual rules):
- Tables and columns are always snake_case, and table names are plural.
- Every table has a primary key plus created_at / updated_at.
- No SELECT *; never run UPDATE / DELETE without WHERE directly in production.
- Money is always DECIMAL(19,4), and times are always stored in UTC.
