# Chat History Search Integration Plan

Inspired by [obra/episodic-memory](https://github.com/obra/episodic-memory), this plan adds chat history ingestion and enhanced search capabilities to the private-journal-worker.

## Overview

The episodic-memory project indexes Claude Code conversations at the **exchange level** (user message + assistant response) and provides semantic, full-text, and hybrid search. We adapt these ideas to run on Cloudflare's stack (D1, Vectorize, Workers AI) alongside existing journal entries.

---

## Phase 1: Enhanced Search on Existing Journal Entries

These changes improve `search_journal` without any new tables or data sources.

### 1.1 Date Range Filtering

**File:** `src/tools/search.ts`, `src/types.ts`, `src/mcp.ts`

Add `after` and `before` (ISO date strings) parameters to `search_journal`:

- Add `after?: string` and `before?: string` to `SearchParams`
- Add them to the tool's `inputSchema` in `mcp.ts`
- In `handleSearch`, after fetching entries from D1 by ID, filter by `entry.date`:
  - `after`: keep entries where `entry.date >= after`
  - `before`: keep entries where `entry.date <= before`
- Alternatively, use Vectorize metadata filtering if the `date` metadata field supports range comparisons (Vectorize metadata filtering supports `$gt`, `$lt` etc. on string fields — verify this works with ISO date strings)

### 1.2 Full-Text Search via D1

**Files:** `schema.sql`, `src/db.ts`, `src/tools/search.ts`

Add FTS5 virtual table for keyword/phrase search:

- **Schema migration:** Add FTS5 table:
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    id UNINDEXED,
    content,
    sections,
    content_rowid=rowid
  );
  ```
- **`db.ts`:** Add `insertEntryFts(env, id, content, sections)` — called alongside `insertEntry`
- **`db.ts`:** Add `searchFts(env, query, limit)` → returns `{id, rank}[]` using `MATCH` and `bm25()`
- **`process-thoughts.ts`:** After inserting into `entries`, also insert into `entries_fts`
- **Admin clear:** Also delete from `entries_fts`

### 1.3 Hybrid Search Mode

**Files:** `src/tools/search.ts`, `src/types.ts`, `src/mcp.ts`

Add a `mode` parameter to `search_journal`: `"vector"` | `"text"` | `"hybrid"` (default: `"hybrid"`)

- `"vector"` — current behavior (Vectorize only)
- `"text"` — FTS5 only, results ranked by BM25
- `"hybrid"` — run both, deduplicate by ID, merge scores:
  - Normalize vector scores to 0-1 (already cosine similarity)
  - Normalize FTS BM25 ranks to 0-1 (min-max within result set)
  - Combined score: `0.7 * vector_score + 0.3 * text_score` (tunable)
  - Entries found by only one method get that score alone

### 1.4 Multi-Concept AND Search

**Files:** `src/tools/search.ts`, `src/types.ts`, `src/mcp.ts`

Allow `query` to accept a string array (2-5 items) for multi-concept search:

- Update `inputSchema` to accept `query` as `string | string[]`
- When array: run independent vector searches for each concept
- Find entries that appear in ALL result sets (intersection by ID)
- Average similarity scores across concepts for final ranking
- Respect the `limit` parameter on final results

---

## Phase 2: Chat History Ingestion

New tool and schema for ingesting Claude Code conversation exchanges.

### 2.1 Exchanges Table

**File:** `schema.sql`

```sql
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL,
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  tool_names TEXT,          -- comma-separated tool names used
  source TEXT DEFAULT 'chat', -- 'chat' vs 'journal' for unified search
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_session ON exchanges(session_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_project ON exchanges(project);
CREATE INDEX IF NOT EXISTS idx_exchanges_date ON exchanges(date DESC);
```

FTS for exchanges:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
  id UNINDEXED,
  user_message,
  assistant_message,
  tool_names
);
```

### 2.2 Ingest Exchanges Tool

**New file:** `src/tools/ingest-exchanges.ts`

New MCP tool `ingest_chat_exchanges`:

```typescript
{
  name: 'ingest_chat_exchanges',
  description: 'Ingest Claude Code conversation exchanges for searchable history.',
  inputSchema: {
    type: 'object',
    properties: {
      exchanges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            user_message: { type: 'string' },
            assistant_message: { type: 'string' },
            session_id: { type: 'string' },
            project: { type: 'string' },
            timestamp: { type: 'number' },
            tool_names: { type: 'array', items: { type: 'string' } }
          },
          required: ['user_message', 'assistant_message']
        },
        description: 'Array of conversation exchanges to index'
      }
    },
    required: ['exchanges']
  }
}
```

**Implementation:**
- For each exchange:
  - Generate ID: `exc-{date}-{timestamp}-{hash}`
  - Build searchable text: `user_message + assistant_message + tool_names`
  - Generate embedding via Workers AI bge-m3
  - Insert into `exchanges` table
  - Insert into `exchanges_fts`
  - Upsert into Vectorize with metadata `{ timestamp, date, source: 'chat', session_id }`
- Batch embedding generation (Workers AI supports batch) for efficiency
- Return `{ success: true, count: N, ids: [...] }`

### 2.3 DB Operations

**File:** `src/db.ts`

Add:
- `insertExchange(env, exchange)` — insert into `exchanges` + `exchanges_fts`
- `getExchangesByIds(env, ids)` — fetch by ID list
- `searchExchangesFts(env, query, limit)` — FTS5 search on exchanges

### 2.4 Unified Search

**File:** `src/tools/search.ts`

Modify `search_journal` (or add a new `search_all` tool) to search across both journals and exchanges:

- Add `source` filter parameter: `"journal"` | `"chat"` | `"all"` (default: `"all"`)
- Vectorize already holds both journal and exchange vectors — semantic search is automatically unified
- For FTS, query both `entries_fts` and `exchanges_fts`, merge results
- Distinguish result types in output:
  ```typescript
  interface SearchResult {
    // ... existing fields
    source: 'journal' | 'chat';
    // for chat results:
    session_id?: string;
    user_message_excerpt?: string;
    assistant_message_excerpt?: string;
  }
  ```
- `read_journal_entry` should also support reading exchanges by ID (detect `exc-` prefix)

---

## Phase 3: Push Sync Client

A standalone script that runs on the user's machine, reads Claude Code conversation files, parses them into exchanges, and pushes them to the worker. Ships as part of this repo (e.g. `sync/` directory) and runs via `npx` or as a Claude Code hook.

### 3.1 JSONL Parser

**New file:** `sync/parse.ts`

Parses Claude Code `.jsonl` conversation files into exchanges:

- **Input:** Path to a `.jsonl` file + project name
- **Output:** Array of parsed exchanges

```typescript
interface ParsedExchange {
  user_message: string;
  assistant_message: string;
  tool_names: string[];
  timestamp: number;
  session_id: string;
  project: string;
  exchange_hash: string;  // deterministic ID for dedup
}
```

**Parsing logic** (mirrors episodic-memory's approach):
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

### 3.2 Sync State Tracker

**New file:** `sync/state.ts`

Tracks which files/sessions have already been synced to avoid re-uploading:

- **State file location:** `~/.config/private-journal/sync-state.json`
- **State structure:**
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
- On each sync run:
  1. Load state file
  2. For each `.jsonl` file, compare current `mtime`/`size` to stored values
  3. Skip files that haven't changed
  4. After successful push, update state entry
- First run syncs everything; subsequent runs are incremental

### 3.3 Push Client

**New file:** `sync/push.ts`

Pushes parsed exchanges to the worker:

- **Auth:** Bearer token from env var `JOURNAL_TOKEN` or `~/.config/private-journal/config.json`
- **Endpoint:** `POST /admin/import-conversations` on the worker
- **Batching:** Send exchanges in batches of 20 per request (keeps payload under ~100KB and avoids Worker CPU limits)
- **Dedup:** Send `exchange_hash` with each exchange; worker skips if already exists (INSERT OR IGNORE)
- **Error handling:** Log failed batches, continue with remaining; retry transient failures (5xx) up to 3 times with backoff
- **Response:** Collect `{ imported, skipped }` counts from each batch, report totals

```typescript
async function pushExchanges(
  exchanges: ParsedExchange[],
  workerUrl: string,
  token: string
): Promise<{ imported: number; skipped: number; errors: number }>
```

### 3.4 CLI Entry Point

**New file:** `sync/cli.ts`

Standalone CLI that orchestrates discover → parse → push:

```
npx private-journal-sync [options]

Options:
  --worker-url <url>    Worker URL (or JOURNAL_WORKER_URL env var)
  --token <token>       Bearer token (or JOURNAL_TOKEN env var)
  --project <name>      Sync only this project (default: all)
  --full                Ignore sync state, re-sync everything
  --dry-run             Parse and report what would be synced, don't push
```

**Pipeline:**
1. **Discover:** Walk `~/.claude/projects/` to find all `<project>/<session>.jsonl` files
2. **Filter:** Check sync state, skip unchanged files
3. **Parse:** For each changed file, run the JSONL parser to extract exchanges
4. **Push:** Batch and push exchanges to the worker
5. **Update state:** Record synced files in state file
6. **Report:** Print summary (`Synced 47 exchanges from 3 sessions, skipped 12 unchanged files`)

### 3.5 Claude Code Hook (Optional)

**New file:** `sync/hooks.json`

Auto-sync on session end via a Claude Code hook:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "stop",
        "command": "npx private-journal-sync --quiet"
      }
    ]
  }
}
```

Alternatively, as a **SessionStart** hook (sync previous sessions when a new one begins):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "npx private-journal-sync --quiet --background"
      }
    ]
  }
}
```

The `--quiet` flag suppresses output except errors. The `--background` flag (SessionStart variant) forks the sync process so it doesn't block session startup.

### 3.6 Worker-Side Import Endpoint

**File:** `src/index.ts`

Add `POST /admin/import-conversations` (auth required):

- Accepts JSON body:
  ```typescript
  {
    exchanges: Array<{
      user_message: string;
      assistant_message: string;
      tool_names?: string[];
      session_id?: string;
      project?: string;
      timestamp?: number;
      exchange_hash: string;  // for dedup
    }>
  }
  ```
- For each exchange:
  - Skip if `exchange_hash` already exists (SELECT before INSERT)
  - Generate embedding via Workers AI
  - Insert into `exchanges` + `exchanges_fts` + Vectorize
- Process in batches of 5-10 (embedding is the bottleneck)
- Returns `{ imported: N, skipped: N, errors: [...] }`

### 3.7 Configuration

**New file:** `sync/config.ts`

Config resolution (first found wins):

1. CLI flags (`--worker-url`, `--token`)
2. Environment variables (`JOURNAL_WORKER_URL`, `JOURNAL_TOKEN`)
3. Config file at `~/.config/private-journal/config.json`:
   ```json
   {
     "worker_url": "https://private-journal.you.workers.dev",
     "token": "your-bearer-token"
   }
   ```

### 3.8 Conversation Stats Tool

**New file:** `src/tools/stats.ts`

New MCP tool `journal_stats`:
- Returns counts: total journal entries, total chat exchanges, entries by project, date range covered
- Simple D1 aggregate queries

---

## Sync Package Structure

```
sync/
  cli.ts          # Entry point: discover → parse → push → report
  parse.ts        # JSONL parser: .jsonl → ParsedExchange[]
  push.ts         # HTTP client: batch push to worker
  state.ts        # Incremental sync state (~/.config/private-journal/sync-state.json)
  config.ts       # Config resolution (CLI > env > file)
  hooks.json      # Optional Claude Code hook for auto-sync
  package.json    # Standalone package, deps: only node built-ins + fetch
```

Minimal dependencies: uses Node built-ins (`fs`, `readline`, `path`, `crypto`) plus native `fetch`. No framework needed.

---

## File Change Summary

| File | Change |
|------|--------|
| **Worker** | |
| `schema.sql` | Add `entries_fts`, `exchanges`, `exchanges_fts` tables + indexes |
| `src/types.ts` | Add `ExchangeRow`, update `SearchParams` (mode, after, before, source), update `SearchResult` |
| `src/db.ts` | Add FTS insert/search, exchange CRUD, exchange FTS |
| `src/embeddings.ts` | No changes (already supports batch) |
| `src/tools/search.ts` | Add hybrid search, multi-concept, date filtering, unified search |
| `src/tools/ingest-exchanges.ts` | **New** — ingest chat exchanges tool |
| `src/tools/stats.ts` | **New** — journal stats tool |
| `src/mcp.ts` | Register new tools, update search schema |
| `src/index.ts` | Add import endpoint |
| `src/tools/process-thoughts.ts` | Add FTS insert on write |
| **Sync client** | |
| `sync/cli.ts` | **New** — CLI entry point |
| `sync/parse.ts` | **New** — JSONL conversation parser |
| `sync/push.ts` | **New** — HTTP push client |
| `sync/state.ts` | **New** — incremental sync state tracker |
| `sync/config.ts` | **New** — config resolution |
| `sync/hooks.json` | **New** — optional Claude Code hook |
| `sync/package.json` | **New** — standalone package |

## Implementation Order

1. **Phase 1.1** — Date filtering (smallest change, immediate value)
2. **Phase 1.2** — FTS5 table + insert path
3. **Phase 1.3** — Hybrid search mode
4. **Phase 1.4** — Multi-concept search
5. **Phase 2.1-2.3** — Exchanges table + ingest tool + worker import endpoint
6. **Phase 2.4** — Unified search across journals + exchanges
7. **Phase 3.1-3.4** — Sync client: parser, state tracker, push client, CLI
8. **Phase 3.5** — Claude Code hook for auto-sync
9. **Phase 3.8** — Stats tool

Each phase is independently deployable. Phase 1 can ship without Phase 2/3. Phase 3 (sync client) requires Phase 2 (exchanges table + import endpoint) on the worker side.

## Key Differences from episodic-memory

| Aspect | episodic-memory | Our approach |
|--------|----------------|--------------|
| Runtime | Local Node.js + SQLite | Cloudflare Worker (edge) |
| Embeddings | Local MiniLM-L6-v2 (384-dim) | Workers AI bge-m3 (1024-dim, higher quality) |
| Vector search | sqlite-vec extension | Cloudflare Vectorize (managed) |
| Full-text | SQL LIKE | D1 FTS5 (proper ranking via BM25) |
| Data source | Auto-sync from local `.jsonl` files | Push via MCP tool or bulk import API |
| Auth | None (local only) | Bearer token + OAuth 2.1 |
| Sync | Background hook on session start | Client pushes; no file system access |

## Open Questions

1. **Vectorize metadata filtering** — Verify that Vectorize supports filtering by `source` metadata field. If not, we run a single query and filter post-hoc (already the pattern for sections).
2. **FTS5 on D1** — Confirm D1 supports FTS5 virtual tables. If not, fall back to `LIKE` queries with appropriate indexing (less ideal but functional).
3. **Exchange size limits** — Claude conversations can be very long. Should we truncate `user_message` / `assistant_message` in the DB, or store full content? Embedding input is already bounded by the model's context window. Consider storing full content but truncating embedding input to ~2000 chars (matching episodic-memory's approach).
4. **Worker CPU limits** — Batch ingestion of many exchanges may hit the 30s CPU limit. The bulk import endpoint should process in small batches and potentially use a queue for very large imports.
