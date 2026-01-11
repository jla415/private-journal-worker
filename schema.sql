-- ABOUTME: D1 database schema for private journal entries and OAuth
-- ABOUTME: Run with: wrangler d1 execute private-journal --file=schema.sql

-- Journal entries table
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL,
  project TEXT,
  sections TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC);
CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);

-- OAuth: Client registrations (RFC 7591)
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

-- OAuth: Authorization codes (short-lived)
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- OAuth: Access and refresh tokens
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  token_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
