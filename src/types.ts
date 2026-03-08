// ABOUTME: TypeScript type definitions for the Worker
// ABOUTME: Includes Env bindings, D1 row types, and tool parameters

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  JOURNAL_TOKEN: string;
  AUTHORIZE_PIN: string; // Required PIN for OAuth authorization
}

// D1 row types
export interface EntryRow {
  id: string;
  timestamp: number;
  date: string;
  project: string | null;
  sections: string; // JSON array
  content: string;
  created_at: number;
}

export interface OAuthClientRow {
  client_id: string;
  client_secret: string;
  redirect_uris: string; // JSON array
  created_at: number;
}

export interface OAuthCodeRow {
  code: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  scope: string;
  expires_at: number;
}

export interface OAuthTokenRow {
  token: string;
  client_id: string;
  token_type: string;
  scope: string;
  expires_at: number;
}

// Tool parameter types
export interface ProcessThoughtsParams {
  feelings?: string;
  project_notes?: string;
  user_context?: string;
  technical_insights?: string;
  world_knowledge?: string;
  project?: string;
}

export interface SearchParams {
  query: string | string[];
  limit?: number;
  sections?: string[];
  project?: string;
  after?: string;
  before?: string;
  mode?: 'vector' | 'text' | 'hybrid';
  source?: 'journal' | 'chat' | 'all';
}

export interface ReadEntryParams {
  id: string;
}

export interface ListRecentParams {
  limit?: number;
  days?: number;
  project?: string;
  source?: 'journal' | 'chat' | 'all';
}

// Search result type
export interface SearchResult {
  id: string;
  path: string; // deprecated alias for id (backward compat, always === id)
  score: number;
  timestamp: number;
  date: string;
  source: 'journal' | 'chat';
  sections?: string[];
  excerpt: string;
  session_id?: string;
  project?: string;
}

// Exchange row type (D1)
export interface ExchangeRow {
  id: string;
  session_id: string | null;
  project: string | null;
  timestamp: number;
  date: string;
  user_message: string;
  assistant_message: string;
  tool_names: string | null;
  created_at: number;
}
