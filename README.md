# Private Journal Worker

A Cloudflare Worker that provides remote MCP journal storage, enabling journal sync across multiple machines.

This is a companion to [private-journal-mcp](https://github.com/obra/private-journal-mcp) - use this when you need cross-machine sync.

## Features

- **Remote sync**: Journal entries accessible from any machine
- **Semantic search**: Vector search via Cloudflare Vectorize (bge-m3, 1024-dim)
- **Flexible auth**: Bearer token for CLI, OAuth 2.1 + PIN for Claude.ai web

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

Same tools as private-journal-mcp:

- **process_thoughts** - Multi-section journaling (feelings, project_notes, user_context, technical_insights, world_knowledge)
- **search_journal** - Semantic search with optional section/project filters
- **read_journal_entry** - Read full entry by ID
- **list_recent_entries** - Browse recent entries

## Architecture

```
Cloudflare Worker (Streamable HTTP MCP)
    ├── Workers AI (bge-m3 embeddings)
    ├── Vectorize (semantic search)
    └── D1 (entry storage)
```

## License

MIT
