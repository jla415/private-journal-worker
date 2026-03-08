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

## Phase 3: Bulk Import Endpoint

### 3.1 Bulk Import Route

**File:** `src/index.ts`

Add `POST /admin/import-conversations` (auth required):

- Accepts a JSON body with an array of parsed exchanges (same shape as the tool)
- Useful for batch importing large conversation archives without MCP overhead
- Processes in batches of 10-20 to stay within Workers CPU limits
- Returns `{ imported: N, skipped: N, errors: [...] }`

### 3.2 Conversation Stats Tool

**New file:** `src/tools/stats.ts`

New MCP tool `journal_stats`:
- Returns counts: total journal entries, total chat exchanges, entries by project, date range covered
- Simple D1 aggregate queries

---

## File Change Summary

| File | Change |
|------|--------|
| `schema.sql` | Add `entries_fts`, `exchanges`, `exchanges_fts` tables + indexes |
| `src/types.ts` | Add `ExchangeRow`, update `SearchParams` (mode, after, before, source), update `SearchResult` |
| `src/db.ts` | Add FTS insert/search, exchange CRUD, exchange FTS |
| `src/embeddings.ts` | No changes (already supports batch) |
| `src/tools/search.ts` | Add hybrid search, multi-concept, date filtering, unified search |
| `src/tools/ingest-exchanges.ts` | **New** — ingest chat exchanges tool |
| `src/tools/stats.ts` | **New** — journal stats tool |
| `src/mcp.ts` | Register new tools, update search schema |
| `src/index.ts` | Add bulk import route |
| `src/tools/process-thoughts.ts` | Add FTS insert on write |

## Implementation Order

1. **Phase 1.1** — Date filtering (smallest change, immediate value)
2. **Phase 1.2** — FTS5 table + insert path
3. **Phase 1.3** — Hybrid search mode
4. **Phase 1.4** — Multi-concept search
5. **Phase 2.1-2.3** — Exchanges table + ingest tool
6. **Phase 2.4** — Unified search across journals + exchanges
7. **Phase 3** — Bulk import + stats

Each phase is independently deployable. Phase 1 can ship without Phase 2/3.

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
