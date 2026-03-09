// ABOUTME: D1 database operations for journal entries and chat exchanges
// ABOUTME: Includes FTS5 full-text search, exchange CRUD, and ID batching

import { Env, EntryRow, ExchangeRow, SearchResult } from './types';

// --- Journal Entry Operations ---

export async function insertEntry(
  env: Env,
  entry: {
    id: string;
    timestamp: number;
    date: string;
    project: string | null;
    sections: string[];
    content: string;
  }
): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO entries (id, timestamp, date, project, sections, content) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(
      entry.id,
      entry.timestamp,
      entry.date,
      entry.project,
      JSON.stringify(entry.sections),
      entry.content
    )
    .run();
}

export async function getEntry(env: Env, id: string): Promise<EntryRow | null> {
  const result = await env.DB.prepare('SELECT * FROM entries WHERE id = ?')
    .bind(id)
    .first<EntryRow>();
  return result;
}

export async function getEntriesByIds(env: Env, ids: string[]): Promise<EntryRow[]> {
  if (ids.length === 0) return [];

  const results: EntryRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(', ');
    const result = await env.DB.prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`)
      .bind(...batch)
      .all<EntryRow>();
    results.push(...result.results);
  }
  return results;
}

export async function listRecentEntries(
  env: Env,
  options: { limit: number; days: number; project?: string }
): Promise<EntryRow[]> {
  const cutoffTimestamp = Date.now() - options.days * 24 * 60 * 60 * 1000;

  let query = 'SELECT * FROM entries WHERE timestamp > ?';
  const params: (string | number)[] = [cutoffTimestamp];

  if (options.project !== undefined) {
    query += ' AND project = ?';
    params.push(options.project);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(options.limit);

  const result = await env.DB.prepare(query).bind(...params).all<EntryRow>();
  return result.results;
}

// --- FTS Operations ---

export async function insertEntryFts(
  env: Env,
  id: string,
  content: string,
  sections: string
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO entries_fts (id, content, sections) VALUES (?, ?, ?)'
  )
    .bind(id, content, sections)
    .run();
}

// Strip FTS5 operators to prevent syntax errors from user input
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[*+\-"^():]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchEntryFts(
  env: Env,
  query: string,
  limit: number
): Promise<{ id: string; rank: number }[]> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const result = await env.DB.prepare(
    'SELECT id, rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?'
  )
    .bind(sanitized, limit)
    .all<{ id: string; rank: number }>();
  return result.results;
}

// --- Exchange Operations ---

export async function insertExchange(
  env: Env,
  exchange: {
    id: string;
    session_id: string | null;
    project: string | null;
    timestamp: number;
    date: string;
    user_message: string;
    assistant_message: string;
    tool_names: string | null;
  }
): Promise<boolean> {
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO exchanges (id, session_id, project, timestamp, date, user_message, assistant_message, tool_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      exchange.id,
      exchange.session_id,
      exchange.project,
      exchange.timestamp,
      exchange.date,
      exchange.user_message,
      exchange.assistant_message,
      exchange.tool_names
    )
    .run();

  const inserted = (result.meta?.changes ?? 1) > 0;

  if (inserted) {
    await insertExchangeFts(
      env,
      exchange.id,
      exchange.user_message,
      exchange.assistant_message,
      exchange.tool_names ?? ''
    );
  }

  return inserted;
}

export async function insertExchangeFts(
  env: Env,
  id: string,
  userMessage: string,
  assistantMessage: string,
  toolNames: string
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO exchanges_fts (id, user_message, assistant_message, tool_names) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userMessage, assistantMessage, toolNames)
    .run();
}

export async function getExchange(env: Env, id: string): Promise<ExchangeRow | null> {
  const result = await env.DB.prepare('SELECT * FROM exchanges WHERE id = ?')
    .bind(id)
    .first<ExchangeRow>();
  return result;
}

export async function getExchangesByIds(env: Env, ids: string[]): Promise<ExchangeRow[]> {
  if (ids.length === 0) return [];

  const results: ExchangeRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(', ');
    const result = await env.DB.prepare(`SELECT * FROM exchanges WHERE id IN (${placeholders})`)
      .bind(...batch)
      .all<ExchangeRow>();
    results.push(...result.results);
  }
  return results;
}

export async function searchExchangeFts(
  env: Env,
  query: string,
  limit: number
): Promise<{ id: string; rank: number }[]> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const result = await env.DB.prepare(
    'SELECT id, rank FROM exchanges_fts WHERE exchanges_fts MATCH ? ORDER BY rank LIMIT ?'
  )
    .bind(sanitized, limit)
    .all<{ id: string; rank: number }>();
  return result.results;
}

export async function listRecentExchanges(
  env: Env,
  options: { limit: number; days: number; project?: string }
): Promise<ExchangeRow[]> {
  const cutoffTimestamp = Date.now() - options.days * 24 * 60 * 60 * 1000;

  let query = 'SELECT * FROM exchanges WHERE timestamp > ?';
  const params: (string | number)[] = [cutoffTimestamp];

  if (options.project !== undefined) {
    query += ' AND project = ?';
    params.push(options.project);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(options.limit);

  const result = await env.DB.prepare(query).bind(...params).all<ExchangeRow>();
  return result.results;
}

// --- Result Converters ---

export function rowToSearchResult(row: EntryRow, score: number): SearchResult {
  const sections: string[] = JSON.parse(row.sections);
  const excerpt = row.content.slice(0, 200) + (row.content.length > 200 ? '...' : '');

  return {
    id: row.id,
    path: row.id,
    score,
    timestamp: row.timestamp,
    date: row.date,
    source: 'journal',
    sections,
    excerpt,
    project: row.project ?? undefined,
  };
}

export function exchangeToSearchResult(row: ExchangeRow, score: number): SearchResult {
  const excerpt = row.user_message.slice(0, 200) + (row.user_message.length > 200 ? '...' : '');

  return {
    id: row.id,
    path: row.id,
    score,
    timestamp: row.timestamp,
    date: row.date,
    source: 'chat',
    excerpt,
    session_id: row.session_id ?? undefined,
    project: row.project ?? undefined,
  };
}
