---
name: journal-sync
description: Sync Claude Code chat history to the journal for searchable recall.
allowed-tools: Bash(journal sync *)
user-invocable: true
argument-hint: [--full | --project name | --dry-run]
---

# Journal Sync

Sync your Claude Code conversation history to the journal worker.

```bash
journal sync $ARGUMENTS
```

If no arguments provided, run incremental sync (only new/changed conversations).

Report the results to the user: how many exchanges were synced, from how many sessions.
