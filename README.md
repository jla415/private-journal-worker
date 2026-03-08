# Private Journal Worker

A Cloudflare Worker that provides remote MCP journal storage with chat history search, enabling journal sync across multiple machines.

This is a companion to [private-journal-mcp](https://github.com/obra/private-journal-mcp) - use this when you need cross-machine sync.

## Features

- **Remote sync**: Journal entries accessible from any machine
- **Chat history ingestion**: Import Claude Code conversations for searchable recall
- **Hybrid search**: Vector, full-text (FTS5), or hybrid mode (0.7 vector + 0.3 text)
- **Multi-concept search**: AND search across multiple query terms
- **Date filtering**: Filter results by date range (after/before)
- **Unified search**: Search across both journal entries and chat exchanges
- **Flexible auth**: Bearer token for CLI, OAuth 2.1 + PIN for Claude.ai web
- **REST API**: HTTP endpoints for programmatic access alongside MCP

## Setup

### 1. Deploy the Worker

```bash
# Clone and install
cd private-journal-worker
npm install

# Create Cloudflare resources
wrangler d1 create private-journal
wrangler vectorize create private-journal --dimensions=1024 --metric=cosine

# Update wrangler.toml with your database/vectorize IDs

# Set authorization PIN
wrangler secret put AUTHORIZE_PIN

# Deploy
wrangler deploy
```

### 2. Configure Claude.ai Web

1. Go to [Claude.ai Settings → Connectors](https://claude.ai/settings/connectors)
2. Click "Add custom connector"
3. Enter your worker URL: `https://private-journal.YOUR-SUBDOMAIN.workers.dev`
4. Enter your PIN when prompted
5. Connection complete

### 3. Configure Claude Code CLI

**Option A: Bearer Token (recommended for CLI)**

```bash
# Set the secret on your worker
wrangler secret put JOURNAL_TOKEN

# Add MCP with bearer auth
claude mcp add --transport http \
  private-journal https://private-journal.YOUR-SUBDOMAIN.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

**Option B: OAuth Flow**

```bash
claude mcp add --transport http \
  private-journal https://private-journal.YOUR-SUBDOMAIN.workers.dev/mcp
```

When first used, Claude Code will open a browser for OAuth authorization. Enter your PIN to complete setup.

## MCP Tools

- **process_thoughts** - Multi-section journaling (feelings, project_notes, user_context, technical_insights, world_knowledge)
- **search_journal** - Search with vector, text, or hybrid mode; supports date filtering, source filtering (journal/chat/all), and multi-concept AND queries
- **read_journal_entry** - Read full entry or chat exchange by ID
- **list_recent_entries** - Browse recent entries and/or exchanges
- **journal_stats** - Aggregate counts, per-project breakdown, and date range

## REST API

All REST endpoints require the same authentication as MCP.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/search?q=...` | Search entries (supports `mode`, `source`, `after`, `before`, `limit`) |
| `GET` | `/api/entries/recent` | List recent entries (supports `limit`, `source`) |
| `GET` | `/api/entries/:id` | Read a single entry or exchange |
| `POST` | `/api/entries` | Create a new journal entry |
| `GET` | `/api/stats` | Get aggregate statistics |
| `POST` | `/api/import` | Import Claude Code chat history |

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/clear?source=...` | Clear entries (optional `source=journal\|chat` filter) |
| `POST` | `/admin/backfill-fts` | Rebuild FTS5 indexes from existing data |

## Chat History Import

Import Claude Code conversations via `POST /api/import` with a JSON body:

```json
{
  "session_id": "abc123",
  "project": "my-project",
  "exchanges": [
    {
      "timestamp": 1700000000,
      "user_message": "How do I parse JSON?",
      "assistant_message": "Use JSON.parse()...",
      "tool_names": ["Read", "Bash"]
    }
  ]
}
```

Exchanges are deduplicated using deterministic hash-based IDs (`exc-{SHA256_prefix}`).

## Architecture

```
Cloudflare Worker (Streamable HTTP MCP + REST API)
    ├── Workers AI (bge-m3 embeddings, 1024-dim)
    ├── Vectorize (semantic search, metadata filtering)
    ├── D1 (entry + exchange storage)
    │   ├── entries + entries_fts (FTS5)
    │   └── exchanges + exchanges_fts (FTS5)
    └── Claude Code Skills
        ├── journal (search & manage)
        ├── journal-reflect (session summaries)
        └── journal-sync (chat history sync)
```

## License

MIT
