// ABOUTME: Search tool - semantic search over journal entries
// ABOUTME: Uses Vectorize for similarity search, D1 for full content

import { Env, SearchParams, SearchResult } from '../types';
import { getEntriesByIds, rowToSearchResult } from '../db';
import { generateEmbedding } from '../embeddings';

export async function handleSearch(
  args: Record<string, unknown>,
  env: Env
): Promise<{ results: SearchResult[] }> {
  const query = args['query'];
  if (typeof query !== 'string') {
    throw new Error('query is required and must be a string');
  }

  const params: SearchParams = {
    query,
    limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
    sections: Array.isArray(args['sections']) ? args['sections'] as string[] : undefined,
    project: typeof args['project'] === 'string' ? args['project'] : undefined,
  };
  const limit = params.limit || 10;

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(env, params.query);

  // Search Vectorize (max topK is 50 with returnMetadata)
  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK: Math.min(limit * 2, 50),
    returnMetadata: true,
  });

  if (!vectorResults.matches || vectorResults.matches.length === 0) {
    return { results: [] };
  }

  // Filter by sections if specified
  let filteredMatches = vectorResults.matches;
  if (params.sections && params.sections.length > 0) {
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
    filteredMatches = vectorResults.matches.filter((match) => {
      const metadata = match.metadata as { sections?: string } | undefined;
      if (!metadata || !metadata.sections) return false;
      const entrySections = metadata.sections.split(',').map(normalize);
      return params.sections!.some((s) => entrySections.includes(normalize(s)));
    });
  }

  // Get IDs and scores
  const idsWithScores = filteredMatches.slice(0, limit).map((match) => ({
    id: match.id,
    score: match.score,
  }));

  if (idsWithScores.length === 0) {
    return { results: [] };
  }

  // Fetch full entries from D1
  const ids = idsWithScores.map((item) => item.id);
  const entries = await getEntriesByIds(env, ids);

  // Filter by project if specified
  let filteredEntries = entries;
  if (params.project !== undefined) {
    filteredEntries = entries.filter((e) => e.project === params.project);
  }

  // Build results with scores
  const scoreMap = new Map(idsWithScores.map((item) => [item.id, item.score]));
  const results = filteredEntries
    .map((entry) => rowToSearchResult(entry, scoreMap.get(entry.id) || 0))
    .sort((a, b) => b.score - a.score);

  return { results };
}
