// ABOUTME: Search tool - vector, full-text, and hybrid search over entries and exchanges
// ABOUTME: Supports date filtering, multi-concept AND search, and source filtering

import { Env, SearchParams, SearchResult } from '../types';
import {
  getEntriesByIds,
  getExchangesByIds,
  rowToSearchResult,
  exchangeToSearchResult,
  searchEntryFts,
  searchExchangeFts,
} from '../db';
import { generateEmbedding, generateEmbeddings } from '../embeddings';

export async function handleSearch(
  args: Record<string, unknown>,
  env: Env
): Promise<{ results: SearchResult[] }> {
  const query = args['query'];
  if (typeof query !== 'string' && !Array.isArray(query)) {
    throw new Error('query is required and must be a string or array of strings');
  }
  if (Array.isArray(query) && query.some((q) => typeof q !== 'string')) {
    throw new Error('query array items must be strings');
  }

  const params: SearchParams = {
    query,
    limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
    sections: Array.isArray(args['sections']) ? (args['sections'] as string[]) : undefined,
    project: typeof args['project'] === 'string' ? args['project'] : undefined,
    after: typeof args['after'] === 'string' ? args['after'] : undefined,
    before: typeof args['before'] === 'string' ? args['before'] : undefined,
    mode: typeof args['mode'] === 'string' ? (args['mode'] as SearchParams['mode']) : undefined,
    source: typeof args['source'] === 'string' ? (args['source'] as SearchParams['source']) : undefined,
  };

  const limit = params.limit || 10;
  const mode = params.mode || 'hybrid';
  const source = params.source || 'all';

  // Multi-concept search: array of queries (cap at 3)
  if (Array.isArray(params.query)) {
    const concepts = params.query.slice(0, 3);
    return multiConceptSearch(env, concepts, limit, params, source);
  }

  const queryStr = params.query as string;

  if (mode === 'vector') {
    return vectorSearch(env, queryStr, limit, params, source);
  } else if (mode === 'text') {
    return textSearch(env, queryStr, limit, params, source);
  } else {
    return hybridSearch(env, queryStr, limit, params, source);
  }
}

// --- Vector search (Vectorize) ---

async function vectorSearch(
  env: Env,
  query: string,
  limit: number,
  params: SearchParams,
  source: string
): Promise<{ results: SearchResult[] }> {
  const queryEmbedding = await generateEmbedding(env, query);

  // Build metadata filter for date range
  const filter: VectorizeVectorMetadataFilter = {};
  if (params.after) filter.timestamp = { $gte: new Date(params.after).getTime() };
  if (params.before) {
    const beforeTs = params.before.includes('T')
      ? new Date(params.before).getTime()
      : new Date(params.before + 'T23:59:59.999Z').getTime();
    filter.timestamp = { ...((filter.timestamp as object) || {}), $lte: beforeTs };
  }

  const hasFilter = Object.keys(filter).length > 0;
  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK: Math.min(limit * 2, 50),
    returnMetadata: true,
    ...(hasFilter ? { filter } : {}),
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

  const idsWithScores = filteredMatches.slice(0, limit).map((match) => ({
    id: match.id,
    score: match.score,
  }));

  if (idsWithScores.length === 0) {
    return { results: [] };
  }

  return fetchAndMergeResults(env, idsWithScores, params.project, source);
}

// --- Full-text search (FTS5) ---

async function textSearch(
  env: Env,
  query: string,
  limit: number,
  params: SearchParams,
  source: string
): Promise<{ results: SearchResult[] }> {
  const idsWithScores: { id: string; score: number }[] = [];

  // Search entries FTS
  if (source === 'all' || source === 'journal') {
    const entryResults = await searchEntryFts(env, query, limit);
    // Normalize BM25 ranks to 0-1
    const normalized = normalizeFtsRanks(entryResults);
    idsWithScores.push(...normalized);
  }

  // Search exchanges FTS
  if (source === 'all' || source === 'chat') {
    const exchangeResults = await searchExchangeFts(env, query, limit);
    const normalized = normalizeFtsRanks(exchangeResults);
    idsWithScores.push(...normalized);
  }

  if (idsWithScores.length === 0) {
    return { results: [] };
  }

  // Sort by score desc and take top limit
  idsWithScores.sort((a, b) => b.score - a.score);
  const topIds = idsWithScores.slice(0, limit);

  return fetchAndMergeResults(env, topIds, params.project, source);
}

// --- Hybrid search (vector + FTS) ---

async function hybridSearch(
  env: Env,
  query: string,
  limit: number,
  params: SearchParams,
  source: string
): Promise<{ results: SearchResult[] }> {
  // Run vector and text search in parallel
  const [vectorResult, textResult] = await Promise.all([
    vectorSearch(env, query, limit, params, source),
    textSearch(env, query, limit, params, source),
  ]);

  // Merge: deduplicate by ID, combine scores
  const scoreMap = new Map<string, { vector: number; text: number }>();

  for (const r of vectorResult.results) {
    scoreMap.set(r.id, { vector: r.score, text: 0 });
  }
  for (const r of textResult.results) {
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.text = r.score;
    } else {
      scoreMap.set(r.id, { vector: 0, text: r.score });
    }
  }

  // Combine scores: 0.7 * vector + 0.3 * text
  const allResults = new Map<string, SearchResult>();
  for (const r of [...vectorResult.results, ...textResult.results]) {
    if (!allResults.has(r.id)) {
      allResults.set(r.id, r);
    }
  }

  const merged: SearchResult[] = [];
  for (const [id, scores] of scoreMap) {
    const result = allResults.get(id);
    if (result) {
      const combinedScore =
        scores.vector > 0 && scores.text > 0
          ? 0.7 * scores.vector + 0.3 * scores.text
          : scores.vector || scores.text;
      merged.push({ ...result, score: combinedScore });
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return { results: merged.slice(0, limit) };
}

// --- Multi-concept AND search ---

async function multiConceptSearch(
  env: Env,
  concepts: string[],
  limit: number,
  params: SearchParams,
  source: string
): Promise<{ results: SearchResult[] }> {
  // Generate embeddings for all concepts in parallel
  const embeddings = await generateEmbeddings(env, concepts);

  // Query Vectorize for each concept in parallel (no metadata for higher topK)
  const conceptResults = await Promise.all(
    embeddings.map((embedding) =>
      env.VECTORIZE.query(embedding, {
        topK: Math.min(limit * 10, 200),
        returnMetadata: false,
      })
    )
  );

  // Find IDs that appear in ALL result sets (intersection)
  const idScoreMaps = conceptResults.map((result) => {
    const map = new Map<string, number>();
    for (const match of result.matches || []) {
      map.set(match.id, match.score);
    }
    return map;
  });

  const firstIds = idScoreMaps[0] ?? new Map();
  const intersectedIds: { id: string; score: number }[] = [];

  for (const [id, score] of firstIds) {
    let allMatch = true;
    let totalScore = score;
    for (let i = 1; i < idScoreMaps.length; i++) {
      const otherScore = idScoreMaps[i].get(id);
      if (otherScore === undefined) {
        allMatch = false;
        break;
      }
      totalScore += otherScore;
    }
    if (allMatch) {
      intersectedIds.push({ id, score: totalScore / concepts.length });
    }
  }

  intersectedIds.sort((a, b) => b.score - a.score);
  const topIds = intersectedIds.slice(0, limit);

  if (topIds.length === 0) {
    return { results: [] };
  }

  return fetchAndMergeResults(env, topIds, params.project, source);
}

// --- Shared helpers ---

function normalizeFtsRanks(results: { id: string; rank: number }[]): { id: string; score: number }[] {
  if (results.length === 0) return [];
  if (results.length === 1) return [{ id: results[0].id, score: 1.0 }];

  // BM25 ranks are negative (more negative = better match)
  const ranks = results.map((r) => r.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const range = maxRank - minRank;

  return results.map((r) => ({
    id: r.id,
    score: range === 0 ? 1.0 : (maxRank - r.rank) / range,
  }));
}

async function fetchAndMergeResults(
  env: Env,
  idsWithScores: { id: string; score: number }[],
  project: string | undefined,
  source: string
): Promise<{ results: SearchResult[] }> {
  // Split IDs by type (exc- prefix = exchange, otherwise = journal entry)
  const entryIds: string[] = [];
  const exchangeIds: string[] = [];

  for (const item of idsWithScores) {
    if (source === 'chat' && !item.id.startsWith('exc-')) continue;
    if (source === 'journal' && item.id.startsWith('exc-')) continue;

    if (item.id.startsWith('exc-')) {
      exchangeIds.push(item.id);
    } else {
      entryIds.push(item.id);
    }
  }

  // Fetch from both tables in parallel
  const [entries, exchanges] = await Promise.all([
    entryIds.length > 0 ? getEntriesByIds(env, entryIds) : Promise.resolve([]),
    exchangeIds.length > 0 ? getExchangesByIds(env, exchangeIds) : Promise.resolve([]),
  ]);

  const scoreMap = new Map(idsWithScores.map((item) => [item.id, item.score]));

  // Convert to SearchResults
  let results: SearchResult[] = [
    ...entries.map((entry) => rowToSearchResult(entry, scoreMap.get(entry.id) || 0)),
    ...exchanges.map((exc) => exchangeToSearchResult(exc, scoreMap.get(exc.id) || 0)),
  ];

  // Filter by project if specified
  if (project !== undefined) {
    results = results.filter((r) => r.project === project);
  }

  results.sort((a, b) => b.score - a.score);
  return { results };
}
