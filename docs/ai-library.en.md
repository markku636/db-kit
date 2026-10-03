# AI library guide

[繁體中文](./ai-library.md) · **English**

All AI behavior in db-kit (the assistant's persona, the DBA reviewers, skills, and the prompt each action sends) comes from the **AI library**: a set of Markdown files. You can edit them directly, share them across the team with git, and sync them to Claude Code and Codex with one click.

Where to open it: **Settings → "Open AI library…"**, or the library button in the AI settings and on the DBA review panel. On the command line, use `dbk ai …` (see the end of this page).

---

## Four kinds of resources

| Folder | What it is | Format |
|---|---|---|
| `agents/<name>.md` | **Persona**: who the reviewer / assistant is, what it cares about, its verdict thresholds | Claude Code subagent format (body = system prompt) |
| `skills/<name>/SKILL.md` | **Skill**: a reusable way of working (online DDL, locking risk, personal-data checks, ...) | Agent Skills standard (shared by Claude Code and Codex) |
| `prompts/<task>.md` | **Task template**: the prompt each AI action actually sends, with context substituted via `{{variables}}` | db-kit specific |
| `contracts/<name>.md` | **Output contract**: the format the parsers depend on (verdict line, reply with exactly one SQL block, ...) | Built-in only, **cannot be overridden** |

A single submitted prompt is assembled like this:

```
System prompt = persona body + skills preloaded by the persona + database tool guidance (only in DBA agent mode)
User message  = task template (with SQL, structure, indexes, rule-engine findings, execution plan, ... substituted via {{variables}}) + output contract
```

Variables are produced by code (truncation, fencing and per-item formatting all live in code); templates only decide wording and sections.

---

## Three layers: built-in < personal < team

| Layer | Location | Notes |
|---|---|---|
| Built-in | Installed with the app | The files themselves are never modified; updated on upgrade |
| Personal | `<settings dir>/ai-library/` | The "Sources & sync" dialog has an open button; `dbk ai path` prints the location |
| Team | Folders you add yourself (can be several, in order) | e.g. a git-cloned `dba-rules/`; can be set to read-only |

**For the same kind of resource with the same `name`, later layers override earlier ones.** To change something built-in, **edit it directly in the library and press "Save as custom version"**:

- What gets saved is a same-named file in the personal layer, which overrides the built-in version; the other language variants (en / zh-CN) are copied over along with it, and later app upgrades won't overwrite your version. The list marks it "Modified".
- Press "**Restore default**" to delete this override file (all language variants together); it goes back to the built-in version and follows upgrades again.
- To keep the built-in one and make a separate copy: for personas and skills, use "Save as new item" with a different name. Prompt template names are fixed to their features, so they can only be edited, not saved as new.
- If there are unsaved changes, switching items, switching tabs or closing the library asks first; **Ctrl+S** saves.

Team folders can use db-kit's structure (`agents/`, `skills/`, `prompts/`) or Claude Code / Codex structure directly (`.claude/agents/`, `.claude/skills/`, `.agents/skills/`), so the same repo can serve db-kit, Claude Code and Codex at the same time.

Check the format in your team repo's CI:

```bash
dbk ai lint --dir .        # non-zero exit code on errors
```

---

## Personas (agents/)

```markdown
---
name: dba-prod-gatekeeper
description: A DBA responsible for approving production changes; would rather block wrongly than let something slip.
dbkit-title: Production gatekeeper
dbkit-role: dba            # dba = DBA reviewer; assistant = assistant
dbkit-db-tools: true       # in DBA agent mode it can query the database itself
maxTurns: 10               # max rounds of querying before reaching a verdict (same-named Claude Code field)
tools: [mcp__dbkit__describe_table, mcp__dbkit__explain_query]   # allowed database tools; omitted = all read-only tools
skills: [lock-risk, online-ddl]                                   # preloaded skills
---
You are the DBA gatekeeper responsible for approving production changes... (this part is the system prompt)
```

- Use lowercase letters, digits and hyphens for `name` (the Claude Code / Agent Skills convention); `description` is required (Claude Code / Codex use it to decide when to use the agent).
- `tools` determines both which tools this DBA can use inside db-kit and the tool allowlist after syncing to Claude Code. Tools outside the list are blocked even when called, not merely "not listed".
- **Write the verdict thresholds in the body**: when to STOP and when to CAUTION. The four built-in DBAs each have different thresholds you can use as references.
- Other Claude Code fields in the file (`model`, `hooks`, `permissionMode`, ...) are left untouched by db-kit and preserved as-is on save.

Built-in personas:

| Name | Purpose |
|---|---|
| `assistant` | Default persona for assistant chat, NL→SQL and the editor's AI actions |
| `dba-senior` | Senior DBA: the default reviewer for regular connections |
| `dba-prod-gatekeeper` | Production gatekeeper: the default for connections marked as production; looks only at structures and plans, never fetches data |
| `dba-performance` | Performance tuning: grounded in execution plans |
| `dba-security` | Security audit: permissions, injection, personal data |

## Skills (skills/)

```markdown
---
name: team-conventions
description: The team's own SQL and schema conventions
dbkit-title: Team conventions
---
During review, also check the following conventions...
```

Skills are used in two ways: **preloaded via a persona's `skills:`** (always included in DBA reviews), and **checked in the assistant chat** (not included in one-shot generations). The "Skills" button in the assistant panel toolbar shows how many are currently enabled; clicking it opens the library's Skills tab, where the checkbox in front of each list item decides which skills the chat includes, and you edit them directly on the right. "Skills checked for assistant chat" in the AI settings is the same selection. The built-in `team-conventions` is a blank template: write your team rules directly into it and save, then add it to a DBA persona's `skills`, and it will be checked on every review.

## Task templates (prompts/)

One file per AI action: `review-sql` (editor DBA review), `review-pre-exec` (Review & Run / `dbk run`), `review-schema` (structure review), `tune-sql`, `explain`, `optimize`, `fix`, `comment`, `convert`, `test-data`, `explain-plan`, `inline-edit`, `nl-sql`, `nl-es`, `nl-shell`, `ssh-*`, `compare-summary`, `run-feedback`, `shell-feedback`, plus the system prompt fragments `tool-guidance` and `ssh-terminal-guidance`.

Syntax (a Mustache subset):

| Syntax | Meaning |
|---|---|
| `{{sql}}` | Substitute a variable (unknown variables output an empty string) |
| `{{#plan}}…{{/plan}}` | Output only if the variable is non-empty |
| `{{^plan}}…{{/plan}}` | Output only if the variable is empty (this is where "what to say when there's no execution plan" goes) |
| `{{contract}}` | Where the output contract goes |
| `{{! comment }}` | Not output |

Section tags that sit alone on a line have the whole line removed, so you can write one tag per line.

Safeguards, so users can't break features by editing templates:

- **The output contract is locked.** If a template doesn't include `{{contract}}`, it is automatically appended at the end.
- **Required variables are guaranteed.** If a template omits a required variable (e.g. `{{sql}}`), it is automatically appended at the end before sending, and the library also shows a warning.
- Overriding a built-in template only replaces the body; the task's variable list, contract and mode always come from the built-in.
- The editor's **preview** renders live with sample data, so you can see what will be sent.

The variables available to each template are listed above the editor as clickable chips (hover for descriptions).

## Language variants

Placing `<name>.en.md` or `<name>.zh-CN.md` next to a file makes it that language's version. The resolution order matches the UI: Japanese / Korean / Vietnamese fall back to English when there's no variant, and then to the base file. The built-in Simplified Chinese variants are generated from the Traditional Chinese base by `node scripts/i18n-gen-zhcn.mjs`. Your own files only need to be written once: the model understands any language, and the reply language is specified separately via `{{reply_language}}`.

---

## Sync to Claude Code / Codex

The library's "Sources & sync" tab, or `dbk ai sync`:

| Target | Writes to |
|---|---|
| Claude Code | `~/.claude/agents/<name>.md`, `~/.claude/skills/<name>/SKILL.md` (`CLAUDE_CONFIG_DIR` takes precedence) |
| Codex | `~/.agents/skills/<name>/SKILL.md`, `~/.codex/agents/<name>.toml` (`CODEX_HOME` takes precedence) |
| Project folder (optional) | `<dir>/.claude/…`, `<dir>/.agents/skills/`, `<dir>/.codex/agents/` |

- By default all DBA personas and skills are synced; you can filter by name (`dba-*, lock-risk`).
- **Only files that db-kit itself wrote, and that haven't been manually edited since, are overwritten.** Your own same-named files, or files edited by hand after syncing, are listed as "Conflict" and skipped. For items deleted from the library, only files whose content hasn't been touched are deleted.
- The plan (Add / Update / Unchanged / Conflict / Delete) is always listed first, and files are written only after you confirm.
- Synced DBA personas use the `mcp__dbkit__*` database tools. To use them in Claude Code, first register dbk's MCP server:

```bash
claude mcp add dbkit -- dbk --conn prod-mysql mcp
claude --agent dba-prod-gatekeeper -p "Review migrate.sql"
```

For Codex, add `[mcp_servers.dbkit]` to `~/.codex/config.toml` with `command = "dbk"` and `args = ["--conn", "prod-mysql", "mcp"]`.

---

## Command line

```bash
dbk ai path                          # locations of the personal layer and team folders
dbk ai list [agent|skill|prompt]     # which copy from which layer is currently in effect
dbk ai show agent/dba-senior         # print the body (--raw prints the whole file, --variant en shows the English version)
dbk ai lint [--dir <folder>]          # check; non-zero exit code on errors
dbk ai sync [--claude] [--codex] [--project <dir>]   # list the sync plan; add --yes to actually write
```

Settings are stored in `<settings dir>/ai-library.json` (team folders, default personas, panel review lineup, sync targets) and shared by the GUI and `dbk`.
