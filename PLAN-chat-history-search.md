# Chat History Search Integration Plan

Inspired by [obra/episodic-memory](https://github.com/obra/episodic-memory), this plan adds chat history ingestion and enhanced search capabilities to the private-journal-worker.

## Overview

The episodic-memory project indexes Claude Code conversations at the **exchange level** (user message + assistant response) and provides semantic, full-text, and hybrid search. We adapt these ideas to run on Cloudflare's stack (D1, Vectorize, Workers AI) alongside existing journal entries.

---

## Phase 1: Enhanced Search on Existing Journal Entries

These changes improve `search_journal` without any new tables or data sources.

### 1.1 Date Range Filtering

**Files:** `src/tools/search.ts`, `src/types.ts`, `src/mcp.ts`

Add `after` and `before` (ISO date strings) parameters to `search_journal`:

- Add `after?: string` and `before?: string` to `SearchParams`
- Add them to the tool's `inputSchema` in `mcp.ts`
- Convert ISO date strings to epoch timestamps for filtering
- Use Vectorize metadata filtering with `$gte`/`$lte` on the numeric `timestamp` metadata field (already stored in Vectorize upsert metadata in `process-thoughts.ts`):
  ```typescript
  const filter: VectorizeVectorMetadataFilter = {};
  if (params.after) filter.timestamp = { $gte: new Date(params.after).getTime() };
  if (params.before) filter.timestamp = { $lte: new Date(params.before + 'T23:59:59.999Z').getTime() };

  // Pass filter into the existing Vectorize query:
  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK: Math.min(limit * 2, 50),
    returnMetadata: true,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
  });
  ```
- **Note:** Vectorize `$gt`/`$lt` only works on numeric fields, NOT strings. Using `timestamp` (already numeric in metadata) is correct.

### 1.2 Full-Text Search via D1

**Files:** `schema.sql`, `src/db.ts`, `src/tools/search.ts`, `src/tools/process-thoughts.ts`

Add FTS5 virtual table for keyword/phrase search.

**Risk:** D1's FTS5 support is unverified. Known Cloudflare bug causes D1 databases with FTS5 tables to become inaccessible after `wrangler d1 export`. **Test FTS5 on D1 first. Never run `wrangler d1 export` on a database with FTS5 tables.**

**Primary approach — FTS5:**
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  id UNINDEXED,
  content,
  sections
);
```

Note: No `content_rowid=rowid` — the `entries` table uses `id TEXT PRIMARY KEY` (not integer rowid), so `content_rowid` is invalid. This is a standalone FTS table. Query pattern:
```sql
SELECT id, rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?
```

**Fallback — LIKE queries (if FTS5 fails on D1):**
```sql
SELECT id FROM entries WHERE content LIKE '%' || ? || '%' ORDER BY timestamp DESC LIMIT ?
```
No new tables needed. Ranking is by recency not relevance. Acceptable for a fallback.

**Implementation:**
- **`db.ts`:** Add `insertEntryFts(env, id, content, sections)` — called alongside `insertEntry`
- **`db.ts`:** Add `searchFts(env, query, limit)` → returns `{id, rank}[]` using `MATCH` and `bm25()`
- **`process-thoughts.ts`:** After inserting into `entries`, also insert into `entries_fts`
- **Admin clear (`src/index.ts`):** Also delete from `entries_fts`
- **Backfill endpoint:** Add `POST /admin/backfill-fts` that reads all existing entries and populates the FTS table. **Must be idempotent** — FTS5 tables have no unique constraint, so re-running without clearing first creates duplicate rows and corrupted search results.
  ```typescript
  // Clear existing FTS data first (idempotent: safe to re-run)
  await env.DB.prepare('DELETE FROM entries_fts').run();
  await env.DB.prepare('DELETE FROM exchanges_fts').run();
  // Backfill entries
  const entries = await env.DB.prepare('SELECT id, content, sections FROM entries').all<EntryRow>();
  for (const row of entries.results) {
    await insertEntryFts(env, row.id, row.content, row.sections);
  }
  // Backfill exchanges
  const exchanges = await env.DB.prepare('SELECT id, user_message, assistant_message, tool_names FROM exchanges').all<ExchangeRow>();
  for (const row of exchanges.results) {
    await insertExchangeFts(env, row.id, row.user_message, row.assistant_message, row.tool_names);
  }
  ```

### 1.3 Hybrid Search Mode

**Files:** `src/tools/search.ts`, `src/types.ts`, `src/mcp.ts`

Add a `mode` parameter to `search_journal`: `"vector"` | `"text"` | `"hybrid"` (default: `"hybrid"`)

- `"vector"` — current behavior (Vectorize only)
- `"text"` — FTS5 only, results ranked by BM25
- `"hybrid"` — run both, deduplicate by ID, merge scores:
  - Normalize vector scores to 0-1 (already cosine similarity)
  - Normalize FTS BM25 ranks to 0-1 (min-max within result set; **single-result edge case: assign 1.0**)
  - Combined score: `0.7 * vector_score + 0.3 * text_score` (tunable)
  - Entries found by only one method get that score alone

### 1.4 Multi-Concept AND Search

**Files:** `src/tools/search.ts`, `src/types.ts`, `src/mcp.ts`

Allow `query` to accept a string array for multi-concept search:

- Update `inputSchema` to accept `query` as `string | string[]`
- **Cap at 3 concepts** (more = slow + low intersection)
- When array: run independent vector searches for each concept using `Promise.all` for parallelism
- **Use `returnMetadata: 'none'` with `topK: 200`** per concept (metadata-free queries allow higher topK)
- Find entries that appear in ALL result sets (intersection by ID)
- Average similarity scores across concepts for final ranking
- Fetch entry metadata from D1 after intersection (not from Vectorize)
- Respect the `limit` parameter on final results

**Note:** Verify Vectorize topK limits. Current code uses `topK: 50` with `returnMetadata: true` which may already be at or above the limit. With `returnMetadata: 'none'`, topK up to 1000 should be supported.

---

## Phase 2: Chat History Ingestion

New tables and endpoints for ingesting Claude Code conversation exchanges.

### 2.1 Exchanges Table

**File:** `schema.sql`

```sql
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,             -- format: exc-{hash} (hash is deterministic for dedup)
  session_id TEXT,
  project TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL,
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  tool_names TEXT,                  -- comma-separated tool names used
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_session ON exchanges(session_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_project ON exchanges(project);
CREATE INDEX IF NOT EXISTS idx_exchanges_date ON exchanges(date DESC);
```

**Design decisions:**
- **No `source` column.** Table identity distinguishes journals from exchanges. `entries` = journal, `exchanges` = chat.
- **Hash as ID.** The `id` is `exc-{hash}` where hash = SHA-256 of `project + session_id + user_message_prefix + timestamp`. The `exc-` prefix enables routing queries to the right table. `INSERT OR IGNORE` handles dedup without a separate column.
- **Full content stored in D1.** No truncation for storage — only embedding input is truncated.

FTS for exchanges:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
  id UNINDEXED,
  user_message,
  assistant_message,
  tool_names UNINDEXED
);
```

**Note:** `tool_names` is `UNINDEXED` — low search value, only stored for retrieval.

### 2.2 Worker Import Endpoint

**File:** `src/index.ts`

Add `POST /admin/import-conversations` (auth required). **No MCP ingest tool** — ingestion happens via CLI/HTTP, so an MCP tool would waste context.

Request body:
```typescript
{
  exchanges: Array<{
    user_message: string;
    assistant_message: string;
    tool_names?: string[];
    session_id?: string;
    project?: string;
    timestamp?: number;
  }>
}
```

**Implementation:**
- For each exchange:
  1. Generate deterministic hash from `project + session_id + user_message_prefix + timestamp`
  2. Build ID: `exc-{hash}`
  3. `INSERT OR IGNORE` into `exchanges` — if row exists, skip entirely (dedup)
  4. Build searchable text for embedding: `user_message + assistant_message`
  5. Truncate to **6,000 characters** before embedding (bge-m3 supports 8,192 tokens ≈ 24K chars; 6K is conservative)
  6. Generate embedding via Workers AI bge-m3
  7. Insert into `exchanges_fts`
  8. Upsert into Vectorize with metadata `{ timestamp, date, source: 'chat', session_id }`
- **Process in batches of 5** per request (embedding is the bottleneck; keeps under 30s Worker CPU limit)
- Returns `{ imported: N, skipped: N, errors: [...] }`

**Vectorize metadata for source filtering:**
- New exchanges get `source: 'chat'` in Vectorize metadata
- Update `process-thoughts.ts` to add `source: 'journal'` to new journal entries going forward
- **No migration for existing vectors.** Convention: missing `source` metadata = `'journal'`. Filter in code after Vectorize query if needed. (Vectorize doesn't expose stored vectors via `getByIds`, so re-upserting would require regenerating all embeddings — infeasible.)

**Atomicity:** Process each exchange as a unit. If Vectorize upsert fails after D1 insert, **delete the D1 row** to keep D1 and Vectorize in sync. No `status` column needed — the rollback-on-failure approach is simpler and the schema stays clean:
```typescript
try {
  await insertExchange(env, exchange);   // D1 + FTS
  await env.VECTORIZE.upsert([vector]);  // Vectorize
} catch (err) {
  await env.DB.prepare('DELETE FROM exchanges WHERE id = ?').bind(exchange.id).run();
  await env.DB.prepare('DELETE FROM exchanges_fts WHERE id = ?').bind(exchange.id).run();
  errors.push({ id: exchange.id, error: err.message });
}
```

### 2.3 DB Operations

**File:** `src/db.ts`

Add:
- `insertExchange(env, exchange)` — insert into `exchanges` + `exchanges_fts`. FTS insert must provide all 4 columns in schema order:
  ```typescript
  await env.DB.prepare('INSERT INTO exchanges_fts (id, user_message, assistant_message, tool_names) VALUES (?, ?, ?, ?)')
    .bind(exchange.id, exchange.user_message, exchange.assistant_message, exchange.tool_names ?? '')
    .run();
  ```
- `insertExchangeFts(env, id, user_message, assistant_message, tool_names)` — standalone FTS insert (used by backfill)
- `getExchangesByIds(env, ids)` — fetch by ID list (same pattern as `getEntriesByIds`, with batching)
- `searchExchangesFts(env, query, limit)` — FTS5 search on exchanges

**D1 bind limit:** `getEntriesByIds` and `getExchangesByIds` use `bind(...ids)` which has a 100-parameter limit. Add batching:
```typescript
async function getEntriesByIds(env: Env, ids: string[]): Promise<EntryRow[]> {
  if (ids.length === 0) return [];
  const results: EntryRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(', ');
    const result = await env.DB.prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`)
      .bind(...batch).all<EntryRow>();
    results.push(...result.results);
  }
  return results;
}
```

### 2.4 Unified Search

**File:** `src/tools/search.ts`, `src/tools/list-recent.ts`, `src/tools/read-entry.ts`

Modify `search_journal` to search across both journals and exchanges:

- Add `source` filter parameter: `"journal"` | `"chat"` | `"all"` (default: `"all"`)
- **ID prefix routing:** After Vectorize query, split matched IDs by prefix:
  - IDs starting with `exc-` → query `exchanges` table via `getExchangesByIds`
  - All other IDs → query `entries` table via `getEntriesByIds`
  - Merge results, preserving scores from Vectorize
- For FTS hybrid mode, query both `entries_fts` and `exchanges_fts`, merge results
- If `source` filter is set, skip the irrelevant table/FTS query
- For Vectorize filtering by source (when `source !== 'all'`): query Vectorize, then filter results in code based on ID prefix (since existing journal vectors lack `source` metadata)

**Update `read_journal_entry`:**
- Detect `exc-` prefix in the `id` parameter (rename from `path` → `id`)
- If `exc-` prefix: query `exchanges` table
- Otherwise: query `entries` table (existing behavior)
- **Note:** Renaming `path` → `id` is a breaking change for existing MCP clients. Accept this since the tool is personal-use only.

**Update `list_recent_entries`:**
- Add optional `source` parameter: `"journal"` | `"chat"` | `"all"` (default: `"all"`)
- When `source` includes chat: also query `exchanges` table ordered by timestamp DESC
- Merge and re-sort by timestamp, apply limit

**Updated SearchResult type:**
```typescript
interface SearchResult {
  id: string;
  path: string;             // deprecated alias for id (kept for backward compat, always === id)
  score: number;
  timestamp: number;
  date: string;
  source: 'journal' | 'chat';
  // Journal fields:
  sections?: string[];
  excerpt: string;
  // Chat fields:
  session_id?: string;
  project?: string;
}
```
**Breaking change note:** The existing `path` field (currently set to `row.id` in `rowToSearchResult`) is kept as a deprecated alias. New code should use `id`. The `path` field will be removed in a future version.

---

## Phase 3: Sync Logic Design

This phase designs the parsing and sync protocol. **No standalone `sync/` package** — implementation lives in `cli/src/commands/sync.ts` (Phase 4).

### 3.1 JSONL Parser Design

Parses Claude Code `.jsonl` conversation files into exchanges:

```typescript
interface ParsedExchange {
  user_message: string;
  assistant_message: string;
  tool_names: string[];
  timestamp: number;
  session_id: string;
  project: string;
}
```

**Parsing algorithm** (mirrors episodic-memory's approach):
1. Stream JSONL line-by-line
2. Only process lines where `type === "user"` or `type === "assistant"`
3. Extract text from `message.content`:
   - If `string`, use directly
   - If `Array`, join all `type: "text"` blocks; collect `type: "tool_use"` names
   - Skip `tool_result` content entirely (bulky, noisy)
4. Group into exchanges: one user message + all subsequent assistant messages until the next user message
5. Generate deterministic hash from `project + session_id + user_message_prefix + timestamp` for dedup

**What gets included vs excluded:**

| Included | Excluded |
|----------|----------|
| User text messages | Tool inputs (file contents, command args) |
| Assistant text responses | Tool outputs (file reads, command results) |
| Tool names used (Read, Edit, Bash...) | `tool_result` blocks |
| Timestamps, session ID, project | Binary/image content |
| | Sidechain messages (`isSidechain: true`) |

### 3.2 Sync State Design

Tracks which files/sessions have already been synced:

- **State file:** `~/.config/private-journal/sync-state.json`
- **Structure:**
  ```typescript
  interface SyncState {
    worker_url: string;
    files: {
      [filePath: string]: {
        mtime: number;       // last modified time when synced
        size: number;         // file size when synced
        last_synced: number;  // when we last pushed
        exchange_count: number;
      }
    }
  }
  ```
- On each sync: compare current mtime/size to stored, skip unchanged files
- First run syncs everything; subsequent runs are incremental

### 3.3 Push Protocol

- **Auth:** Bearer token from env var `JOURNAL_TOKEN` or `~/.config/private-journal/config.json`
- **Endpoint:** `POST /admin/import-conversations`
- **Batching:** Send exchanges in batches of 5-10 per request (embedding is the bottleneck)
- **Dedup:** Hash-based ID means `INSERT OR IGNORE` handles server-side dedup
- **Error handling:** Log failed batches, continue with remaining; retry 5xx up to 3 times with backoff

### 3.4 File Discovery

Walk `~/.claude/projects/` to find `<project>/<session>.jsonl` files. Project name = directory name.

---

## Phase 4: CLI Tool & Claude Code Skills

Skills use less context than MCP — MCP tool definitions load every message (~800-1000 tokens), while skill descriptions are ~50 tokens and only expand on invocation. **~10x less context usage** for typical sessions.

### 4.1 REST API Endpoints (Worker-Side Prerequisite)

**File:** `src/index.ts`

The CLI needs clean REST endpoints. Current worker only exposes MCP JSON-RPC at `/mcp`.

```
GET  /api/search?q=<query>&limit=N&offset=N&mode=vector|text|hybrid&after=DATE&before=DATE&source=journal|chat|all&project=NAME
GET  /api/entries/:id
GET  /api/entries/recent?limit=N&days=N&project=NAME&source=journal|chat|all
POST /api/entries                    # Create journal entry (same body as process_thoughts)
POST /api/import                     # Bulk import exchanges (alias for /admin/import-conversations)
GET  /api/stats
```

All endpoints require `Authorization: Bearer <token>`. Responses are JSON.

**Implementation notes:**
- Both MCP and REST call the same handler functions (`handleSearch`, `handleProcessThoughts`, etc.)
- MCP wraps results in `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`; REST returns raw objects
- **Path parameter extraction:** Current routing uses `if (path === '...')` string matching. `GET /api/entries/:id` requires pattern matching. Use simple regex: `const match = path.match(/^\/api\/entries\/(.+)$/)`
- **Pagination:** `GET /api/search` and `GET /api/entries/recent` accept `offset` parameter for pagination. `offset` skips N results after sorting.

### 4.2 CLI Tool: `journal`

**New directory:** `cli/`

```
cli/
  src/
    index.ts        # Entry point, command router
    commands/
      search.ts     # Semantic search
      read.ts       # Read full entry
      recent.ts     # List recent entries
      write.ts      # Create journal entry
      sync.ts       # Sync chat history (Phase 3 logic lives here)
      stats.ts      # Show stats
    client.ts       # HTTP client wrapper (auth, retries, base URL)
    config.ts       # Config resolution
    output.ts       # Formatting (table, json, markdown)
  package.json
  tsconfig.json
```

**Commands:**

```bash
# Search
journal search "authentication patterns"
journal search "debugging tips" --limit 5 --mode hybrid
journal search "auth" --after 2025-01-01 --before 2025-06-01
journal search "auth" --source chat    # only chat history
journal search "auth" --project myapp

# Read
journal read <entry-id>
journal read <entry-id> --json         # machine-readable output

# Recent
journal recent
journal recent --days 7 --project myapp

# Write (multi-section)
journal write --feelings "frustrated with auth" --project-notes "OAuth PKCE flow working"
journal write --stdin                   # read content from stdin (piped input)

# Sync chat history (Phase 3 logic)
journal sync                            # incremental sync
journal sync --full                     # re-sync everything
journal sync --project myapp            # sync single project
journal sync --dry-run                  # preview what would sync

# Stats
journal stats
journal stats --json
```

**Config resolution** (first found wins):
1. CLI flags (`--worker-url`, `--token`)
2. Environment variables: `JOURNAL_WORKER_URL`, `JOURNAL_TOKEN`
3. Config file: `~/.config/private-journal/config.json`

**Setup command:**
```bash
journal config set --url https://private-journal.you.workers.dev --token <token>
```

**Output formats:**
- Default: human-readable (colored, truncated excerpts, relative dates)
- `--json`: machine-readable JSON (for piping to other tools or skills)
- `--markdown`: markdown-formatted (useful when Claude reads the output)

**Package & distribution:**
- Published as `private-journal-cli` (or scoped `@jla415/journal-cli`)
- Installable via `npm install -g` or usable via `npx`
- Zero heavy dependencies — uses native `fetch`, `readline`, `crypto`
- Single `bin` entry: `"journal": "./dist/index.js"`

### 4.3 Claude Code Skill: `journal`

**File: `.claude/skills/journal/SKILL.md`**

```yaml
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
\`\`\`bash
journal search "your query" --json
journal search "your query" --limit 5 --json
journal search "your query" --source chat --json     # search only chat history
journal search "your query" --source journal --json  # search only journal entries
journal search "your query" --mode text --json       # keyword search (not semantic)
journal search "your query" --after 2025-01-01 --json
\`\`\`

### Read full entry
\`\`\`bash
journal read <entry-id> --json
\`\`\`

### Recent entries
\`\`\`bash
journal recent --days 7 --json
\`\`\`

### Write new entry
\`\`\`bash
journal write --feelings "content" --project-notes "content" --technical-insights "content"
\`\`\`

## Usage Guidelines

- Always use `--json` flag so you can parse the structured output
- When the user asks you to "remember" or "note" something, use `journal write`
- When the user asks "have I seen this before" or "what did I think about X", use `journal search`
- Present search results as a concise summary, not raw JSON
- If a search returns relevant results, offer to read the full entry
- Limit searches to 5 results unless the user asks for more
```

**Skill pattern note:** `Bash(journal *)` requires a space after "journal", so bare `journal` (no args) won't match. This is acceptable — all useful commands have arguments. Using `Bash(journal*)` (no space) would match `journalctl` and other system commands, which is worse.

### 4.4 Claude Code Skill: `journal-reflect`

**File: `.claude/skills/journal-reflect/SKILL.md`**

```yaml
---
name: journal-reflect
description: End-of-session reflection — summarize what was accomplished and save insights to the journal.
allowed-tools: Bash(journal *)
user-invocable: true
---

# Session Reflection

Review what happened in this session and save key insights to the journal.

## Steps

1. Summarize the main tasks accomplished in this session
2. Identify any technical insights worth preserving
3. Note any decisions made and their rationale
4. Record observations about the user's working patterns or preferences
5. Save to journal using appropriate sections:

\`\`\`bash
journal write \
  --project-notes "what was built/changed" \
  --technical-insights "what was learned" \
  --user-context "preferences or patterns noticed"
\`\`\`

Keep entries concise. Focus on insights that would be valuable to recall later, not a play-by-play of the session.
```

### 4.5 Claude Code Skill: `journal-sync`

**File: `.claude/skills/journal-sync/SKILL.md`**

```yaml
---
name: journal-sync
description: Sync Claude Code chat history to the journal for searchable recall.
allowed-tools: Bash(journal sync *)
user-invocable: true
argument-hint: [--full | --project name | --dry-run]
---

# Journal Sync

Sync your Claude Code conversation history to the journal worker.

\`\`\`bash
journal sync $ARGUMENTS
\`\`\`

If no arguments provided, run incremental sync (only new/changed conversations).

Report the results to the user: how many exchanges were synced, from how many sessions.
```

### 4.6 SessionStart Hook (Optional Auto-Sync)

**File: `.claude/settings.json`** (or project-level)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "journal sync --quiet 2>/dev/null &",
        "timeout": 5000
      }
    ]
  }
}
```

Background sync on session start — fires and forgets. Keeps the vector DB current without manual `/journal-sync` invocation.

**Concurrent sync risk:** If SessionStart hook triggers while user manually runs `/journal-sync`, two syncs run simultaneously. `INSERT OR IGNORE` handles exact duplicates, but add a file lock (`~/.config/private-journal/sync.lock`) to prevent concurrent syncs.

### 4.7 Stats Tool

**File:** `src/tools/stats.ts`

New MCP tool `journal_stats`:
- Returns counts: total journal entries, total chat exchanges, entries by project, date range covered
- Simple D1 aggregate queries
- Also exposed via REST: `GET /api/stats`

### 4.8 Plugin Packaging

Package as a distributable Claude Code plugin:

```
private-journal-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── journal/SKILL.md
│   ├── journal-reflect/SKILL.md
│   └── journal-sync/SKILL.md
├── hooks/hooks.json
├── commands/journal-setup.md
├── scripts/setup.sh
└── README.md
```

Install: `/plugin install private-journal` → runs setup wizard → ready to use.

---

## Admin Endpoints Update

**File:** `src/index.ts`

### `/admin/clear` — updated to handle all tables

Add optional `?source=journal|chat` parameter:

- No parameter: clear everything (entries + exchanges + all Vectorize vectors)
- `?source=journal`: clear `entries` + `entries_fts`, delete Vectorize vectors by ID (get IDs from D1, not Vectorize)
- `?source=chat`: clear `exchanges` + `exchanges_fts`, delete Vectorize vectors by ID (get IDs from D1)

**Note:** Vectorize has no "query all by metadata" API, so get IDs from the D1 table first, then `deleteByIds` in batches of 100.

### `/admin/backfill-fts` — new

Backfill FTS tables for both entries and exchanges. Clears existing FTS data first (idempotent), then reads all rows from `entries` and `exchanges`, inserting into their respective FTS tables. See Phase 1.2 for implementation code.

---

## File Change Summary

| File | Change |
|------|--------|
| **Worker** | |
| `schema.sql` | Add `entries_fts`, `exchanges`, `exchanges_fts` tables + indexes |
| `src/types.ts` | Add `ExchangeRow`, update `SearchParams` (mode, after, before, source), update `SearchResult` |
| `src/db.ts` | Add FTS insert/search, exchange CRUD, exchange FTS, ID batching for >100 |
| `src/embeddings.ts` | Add `extractExchangeText(user_msg, assistant_msg)` with 6K char truncation |
| `src/tools/search.ts` | Add hybrid search, multi-concept, date filtering, unified search with ID prefix routing |
| `src/tools/read-entry.ts` | Support exchange IDs (detect `exc-` prefix), rename `path` param to `id` |
| `src/tools/list-recent.ts` | Add `source` filter, query both tables |
| `src/tools/stats.ts` | **New** — journal stats tool |
| `src/mcp.ts` | Register stats tool, update search/read schemas |
| `src/index.ts` | Add import endpoint, backfill-fts endpoint, REST API routes, update admin/clear |
| `src/tools/process-thoughts.ts` | Add FTS insert on write, add `source: 'journal'` to Vectorize metadata |
| **CLI** | |
| `cli/src/index.ts` | **New** — CLI entry point |
| `cli/src/commands/*.ts` | **New** — search, read, recent, write, sync, stats commands |
| `cli/src/client.ts` | **New** — HTTP client wrapper |
| `cli/src/config.ts` | **New** — config resolution |
| `cli/src/output.ts` | **New** — output formatting |
| `cli/package.json` | **New** — standalone package |
| **Skills** | |
| `.claude/skills/journal/SKILL.md` | **New** — main journal skill |
| `.claude/skills/journal-reflect/SKILL.md` | **New** — reflection skill |
| `.claude/skills/journal-sync/SKILL.md` | **New** — sync skill |

## Implementation Order

1. **Phase 1.1** — Date filtering (use numeric `timestamp` for Vectorize)
2. **Phase 1.2** — FTS5 table + insert path (**verify FTS5 on D1 first**; have LIKE fallback ready)
3. **Phase 1.2b** — FTS backfill endpoint for existing entries
4. **Phase 1.3** — Hybrid search mode
5. **Phase 1.4** — Multi-concept search (cap at 3, parallel embeddings, topK:200 without metadata)
6. **Phase 2.1** — Exchanges table schema
7. **Phase 2.2** — Worker import endpoint + Vectorize metadata update to `process-thoughts.ts`
8. **Phase 2.3** — Exchange DB operations
9. **Phase 2.4** — Unified search (ID prefix routing, update list-recent, update read-entry)
10. **Phase 4.1** — REST API endpoints on worker
11. **Phase 4.2** — CLI tool with search/read/write commands
12. **Phase 4.2b** — CLI sync command (Phase 3 parsing + push logic)
13. **Phase 4.3-4.5** — Claude Code skills (journal, reflect, sync)
14. **Phase 4.6** — SessionStart hook for auto-sync
15. **Phase 4.7** — Stats tool
16. **Phase 4.8** — Plugin packaging

Each phase is independently deployable. Phase 1 ships without Phase 2-4. Phase 2 (exchanges) is prerequisite for Phase 4 sync command.

---

## Key Differences from episodic-memory

| Aspect | episodic-memory | Our approach |
|--------|----------------|--------------|
| Runtime | Local Node.js + SQLite | Cloudflare Worker (edge) |
| Embeddings | Local MiniLM-L6-v2 (384-dim) | Workers AI bge-m3 (1024-dim, 8192-token context) |
| Vector search | sqlite-vec extension | Cloudflare Vectorize (managed) |
| Full-text | SQL LIKE | D1 FTS5 (proper ranking via BM25) with LIKE fallback |
| Data source | Auto-sync from local `.jsonl` files | Push via CLI + HTTP import API |
| Auth | None (local only) | Bearer token + OAuth 2.1 |
| Sync | Background hook on session start | CLI push; SessionStart hook optional |

---

## Known Risks & Constraints

1. **FTS5 on D1** — Unverified. LIKE fallback designed. Test before committing.
2. **Vectorize topK with metadata** — Current code uses `topK: 50` with `returnMetadata: true`. Verify this is within limits. If capped at 20, reduce default or switch to metadata-free queries + D1 lookup.
3. **Worker CPU limits** — 30s CPU limit. Import endpoint processes 5 exchanges per batch. Monitor real-world timing.
4. **Workers AI rate limits** — Batch embedding + sync could hit limits. Add backoff in CLI sync.
5. **Vectorize free plan** — 5M vector limit. At ~10 exchanges/session, 50 sessions/day = 500 vectors/day = ~27 years before limit. Not a concern for personal use.
6. **No vector migration** — Existing journal vectors lack `source` metadata. Treat missing = journal. Don't attempt to re-upsert (Vectorize doesn't expose stored vectors).

---

## Pre-Existing Bug (Unrelated to Plan)

**OAuth refresh token never persists (`src/oauth.ts:353-355`).** The code calls `env.DB.prepare(...).bind(...)` but never calls `.run()`. New access tokens from refresh are silently not saved. Should be fixed independently.
