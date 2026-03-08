// ABOUTME: Stats tool - returns aggregate counts for journal entries and exchanges
// ABOUTME: Provides totals, per-project breakdown, and date range covered

import { Env } from '../types';

interface StatsResult {
  journal_entries: number;
  chat_exchanges: number;
  projects: { name: string; entries: number; exchanges: number }[];
  date_range: { earliest: string | null; latest: string | null };
}

export async function handleStats(
  _args: Record<string, unknown>,
  env: Env
): Promise<StatsResult> {
  const [entryCount, exchangeCount, entryProjects, exchangeProjects, dateRange] =
    await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM entries').first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) as count FROM exchanges').first<{ count: number }>(),
      env.DB.prepare(
        'SELECT COALESCE(project, "(none)") as name, COUNT(*) as count FROM entries GROUP BY project ORDER BY count DESC'
      ).all<{ name: string; count: number }>(),
      env.DB.prepare(
        'SELECT COALESCE(project, "(none)") as name, COUNT(*) as count FROM exchanges GROUP BY project ORDER BY count DESC'
      ).all<{ name: string; count: number }>(),
      env.DB.prepare(
        'SELECT MIN(date) as earliest, MAX(date) as latest FROM (SELECT date FROM entries UNION ALL SELECT date FROM exchanges)'
      ).first<{ earliest: string | null; latest: string | null }>(),
    ]);

  // Merge project counts
  const projectMap = new Map<string, { entries: number; exchanges: number }>();
  for (const p of entryProjects.results) {
    projectMap.set(p.name, { entries: p.count, exchanges: 0 });
  }
  for (const p of exchangeProjects.results) {
    const existing = projectMap.get(p.name);
    if (existing) {
      existing.exchanges = p.count;
    } else {
      projectMap.set(p.name, { entries: 0, exchanges: p.count });
    }
  }

  return {
    journal_entries: entryCount?.count ?? 0,
    chat_exchanges: exchangeCount?.count ?? 0,
    projects: Array.from(projectMap.entries()).map(([name, counts]) => ({
      name,
      ...counts,
    })),
    date_range: {
      earliest: dateRange?.earliest ?? null,
      latest: dateRange?.latest ?? null,
    },
  };
}
