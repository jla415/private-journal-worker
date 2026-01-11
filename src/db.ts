// ABOUTME: D1 database operations for journal entries
// ABOUTME: Uses direct access pattern (no .get()) for required fields

import { Env, EntryRow, SearchResult } from './types';

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

  // D1 doesn't support arrays directly, use IN with placeholders
  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<EntryRow>();

  return result.results;
}

export async function listRecentEntries(
  env: Env,
  options: { limit: number; days: number; project?: string }
): Promise<EntryRow[]> {
  const cutoffTimestamp = Date.now() - options.days * 24 * 60 * 60 * 1000;

  let query = 'SELECT * FROM entries WHERE timestamp > ?';
  const params: (string | number)[] = [cutoffTimestamp];

  if (options.project !== undefined) {
    if (options.project === null || options.project === '') {
      query += ' AND project IS NULL';
    } else {
      query += ' AND project = ?';
      params.push(options.project);
    }
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(options.limit);

  const result = await env.DB.prepare(query).bind(...params).all<EntryRow>();
  return result.results;
}

export function rowToSearchResult(row: EntryRow, score: number): SearchResult {
  const sections: string[] = JSON.parse(row.sections);
  const excerpt = row.content.slice(0, 200) + (row.content.length > 200 ? '...' : '');

  return {
    id: row.id,
    score,
    timestamp: row.timestamp,
    date: row.date,
    sections,
    excerpt,
    path: row.id, // Use ID as path for remote entries
  };
}
