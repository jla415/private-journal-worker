// ABOUTME: List recent entries tool - chronological listing
// ABOUTME: Supports filtering by days and project

import { Env, ListRecentParams, SearchResult } from '../types';
import { listRecentEntries, rowToSearchResult } from '../db';

export async function handleListRecent(
  args: Record<string, unknown>,
  env: Env
): Promise<{ entries: SearchResult[] }> {
  const params = args as ListRecentParams;
  const limit = params.limit || 10;
  const days = params.days || 30;

  const entries = await listRecentEntries(env, {
    limit,
    days,
    project: params.project,
  });

  // Convert to SearchResult format (score = 1.0 for chronological results)
  const results = entries.map((entry) => rowToSearchResult(entry, 1.0));

  return { entries: results };
}
