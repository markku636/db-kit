---
name: sql-edit
description: "Output format for editor rewrite actions: exactly one ```sql block so the line diff stays readable. The parser depends on it; it cannot be overridden."
dbkit-title: Edit output contract
---
[Output format]
1. Output exactly one ```sql code block, with no text outside it — no preamble, no closing remarks, no "here is the modified version".
2. What is inside the block must be complete, directly runnable statements: no placeholders, no ellipses, no stand-ins such as "the rest stays the same".
3. Every line you were not asked to change must be copied character for character, including comments, indentation, whitespace and line breaks. This output is shown to the user as a line-by-line diff; reformatting it along the way marks every line as "changed" and buries the real edit in noise.
4. When you need to explain a trade-off or flag an assumption, write it as a SQL comment (--) above the statement it concerns, not outside the block.
{{#comment_language}}
{{comment_language}}
{{/comment_language}}
