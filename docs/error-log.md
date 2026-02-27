# Error Investigation Log

A simple markdown-based log for tool errors and agent-reported anomalies. Feeds into reflection and review sessions.

## Location

```
~/.dev-tools/{project-slug}/error-log.md
```

## How It Works

### Auto-Captured Errors

When any of the 16 dev-tools tools returns an error, an entry is automatically appended to the error log:

```markdown
### 2026-02-27T14:00 — `shell`

**Source:** 🤖 Auto-captured
**Status:** `unresolved`
**Params:** command: npm run build, timeout: 120000
**Error:** Command timed out after 120s

---
```

**Deduplication:** The same tool + error combination won't be logged again within a 1-minute window. This prevents log spam from repeated failures.

### Agent-Reported Issues

Agents can manually report anomalies they observe during work:

```
code_diagnose { action: "report_issue", tool: "code_search", issue: "Semantic search returned irrelevant results for 'authentication middleware'" }
```

These are logged with `👤 Agent-reported` source.

### Viewing the Log

```
code_diagnose { action: "error_log" }
```

Returns a summary with counts and unresolved items:

```
Error log: 5 total — 3 unresolved, 1 resolved, 1 won't fix

Unresolved items:
- `shell` (2026-02-27T14:00): Command timed out after 120s
- `code_search` (2026-02-27T14:05): Semantic search returned irrelevant results...
- `test` (2026-02-27T14:10): Jest not found in PATH
```

### Resolving Items

Resolution is done by editing the markdown file directly or programmatically via `resolveErrorLogEntry()`. The status line changes from:

```
**Status:** `unresolved`
```

to:

```
**Status:** `resolved` — Installed jest globally
```

## Entry Format

Each entry is a markdown section with:

| Field | Description |
|---|---|
| **Timestamp** | ISO 8601 (truncated to minutes) |
| **Tool** | Which dev-tools tool errored |
| **Source** | `🤖 Auto-captured` or `👤 Agent-reported` |
| **Status** | `unresolved`, `resolved`, or `wontfix` |
| **Params** | Compact summary of tool call parameters (auto-captured only) |
| **Error** | Error message or issue description |

## Use in Reflections

During Sunday reflection sessions:

1. Run `code_diagnose { action: "error_log" }` to see unresolved items
2. For each item, decide: investigate, resolve, or mark as won't fix
3. Patterns in the log reveal:
   - Tools that fail frequently → need hardening
   - Recurring agent observations → possible bugs
   - Timeout patterns → need config tuning
