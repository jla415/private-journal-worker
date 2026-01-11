# Private Journal Worker

A Cloudflare Worker that provides remote MCP journal storage, enabling journal sync across multiple machines.

This is a companion to [private-journal-mcp](https://github.com/obra/private-journal-mcp) - use this when you need cross-machine sync.

## Features

- **Remote sync**: Journal entries accessible from any machine
- **Semantic search**: Vector search via Cloudflare Vectorize (bge-m3, 1024-dim)
- **OAuth 2.1**: For Claude.ai web integration
- **Bearer token**: For Claude Code CLI access
- **Import tool**: Migrate existing local journals

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

# Set bearer token secret
wrangler secret put JOURNAL_TOKEN

# Deploy
wrangler deploy
```

### 2. Configure Claude Code CLI

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer $JOURNAL_TOKEN" \
  private-journal https://private-journal.YOUR-SUBDOMAIN.workers.dev/mcp
```

### 3. Import Existing Journals

```bash
# Dry run to see what would be imported
npx ts-node scripts/import-local.ts --dry-run

# Import from ~/.claude-journals/
JOURNAL_TOKEN=your-token npx ts-node scripts/import-local.ts

# Import project-specific journal
JOURNAL_TOKEN=your-token npx ts-node scripts/import-local.ts \
  /path/to/project/.private-journal --project myproject

# Skip central journals, only import specified directories
JOURNAL_TOKEN=your-token npx ts-node scripts/import-local.ts \
  --skip-central /path/to/.private-journal --project projectname
```

## MCP Tools

Same tools as private-journal-mcp:

- **process_thoughts** - Multi-section journaling (feelings, project_notes, user_context, technical_insights, world_knowledge)
- **search_journal** - Semantic search with optional section/project filters
- **read_journal_entry** - Read full entry by ID
- **list_recent_entries** - Browse recent entries

## Admin Endpoints

```bash
# Clear all entries (requires auth)
curl -X POST -H "Authorization: Bearer $JOURNAL_TOKEN" \
  https://private-journal.YOUR-SUBDOMAIN.workers.dev/admin/clear
```

## Architecture

```
Cloudflare Worker (Streamable HTTP MCP)
    ├── Workers AI (bge-m3 embeddings)
    ├── Vectorize (semantic search)
    └── D1 (entry storage)
```

## License

MIT
