---
name: journal
description: Search and manage your private journal. Use when you need to recall past thoughts, find technical insights, search chat history, or record new observations.
allowed-tools: Bash(journal *)
user-invocable: true
argument-hint: [search query or command]
---

# Private Journal

You have access to a private journal via the `journal` CLI tool. Use it to search past entries, read full content, or write new thoughts.

## Available Commands

### Search (most common)
```bash
journal search "your query" --json
journal search "your query" --limit 5 --json
journal search "your query" --source chat --json     # search only chat history
journal search "your query" --source journal --json  # search only journal entries
journal search "your query" --mode text --json       # keyword search (not semantic)
journal search "your query" --after 2025-01-01 --json
```

### Read full entry
```bash
journal read <entry-id> --json
```

### Recent entries
```bash
journal recent --days 7 --json
```

### Write new entry
```bash
journal write --feelings "content" --project-notes "content" --technical-insights "content"
```

## Usage Guidelines

- Always use `--json` flag so you can parse the structured output
- When the user asks you to "remember" or "note" something, use `journal write`
- When the user asks "have I seen this before" or "what did I think about X", use `journal search`
- Present search results as a concise summary, not raw JSON
- If a search returns relevant results, offer to read the full entry
- Limit searches to 5 results unless the user asks for more
