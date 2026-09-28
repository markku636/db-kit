---
name: run-feedback
description: The result sent back to the model after Run in the assistant chat.
dbkit-title: SQL run feedback
---
Below is the result of running this SQL directly in MAGIDB CONNECT just now. Continue the analysis from there.

[Executed SQL]
{{sql}}

{{#failed}}
[Error message]
{{error}}
{{/failed}}
{{^failed}}
[Run result]
{{result}}
{{/failed}}

Elapsed: {{elapsed}}

[What to do next]
{{#failed}}
First explain why this SQL failed (say whether it is a syntax, missing-object, type, privilege or data problem), then give one corrected, directly runnable statement in a single ```sql block: preserve the original intent and leave no placeholders or ellipses.
{{/failed}}
{{^failed}}
Continue the analysis from this result: what the data means, and whether there is anything anomalous or any trend worth noting. If you need more data to reach a conclusion, give the next runnable statement directly in a single ```sql block and say what that query is meant to verify.
{{/failed}}
