// ABOUTME: List recent entries tool - chronological listing
// ABOUTME: Supports filtering by days, project, and source (journal/chat/all)

import { Env, ListRecentParams, SearchResult } from '../types';
import { listRecentEntries, listRecentExchanges, rowToSearchResult, exchangeToSearchResult } from '../db';

export async function handleListRecent(
  args: Record<string, unknown>,
  env: Env
): Promise<{ entries: SearchResult[] }> {
  const params = args as ListRecentParams;
  const limit = params.limit || 10;
  const days = params.days || 30;
  const source = params.source || 'all';

  const results: SearchResult[] = [];

  // Fetch journal entries
  if (source === 'all' || source === 'journal') {
    const entries = await listRecentEntries(env, {
      limit,
      days,
      project: params.project,
    });
    results.push(...entries.map((entry) => rowToSearchResult(entry, 1.0)));
  }

  // Fetch chat exchanges
  if (source === 'all' || source === 'chat') {
    const exchanges = await listRecentExchanges(env, {
      limit,
      days,
      project: params.project,
    });
    results.push(...exchanges.map((exc) => exchangeToSearchResult(exc, 1.0)));
  }

  // Sort by timestamp descending and apply limit
  results.sort((a, b) => b.timestamp - a.timestamp);

  return { entries: results.slice(0, limit) };
}
