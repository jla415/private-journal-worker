// ABOUTME: Sync orchestrator - discovers JSONL files, parses exchanges, POSTs to import API
// ABOUTME: Supports incremental sync, dry-run, and batch uploading

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readAndParseJSONLFile, Exchange } from './parse-jsonl';
import { extractProjectName } from './project-name';

export interface SyncOptions {
  claudeDir: string;
  apiUrl: string;
  apiToken: string;
  dryRun: boolean;
  full: boolean;
  project?: string;
  fetchFn?: typeof fetch;
}

export interface SyncResult {
  filesProcessed: number;
  exchangesParsed: number;
  imported: number;
  skipped: number;
  errors: number;
}

type SyncState = Record<string, number>; // filePath -> mtimeMs

const BATCH_SIZE = 100;
const STATE_FILE = '.journal-sync-state.json';

function loadSyncState(claudeDir: string): SyncState {
  const statePath = join(claudeDir, STATE_FILE);
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }
  return {};
}

function saveSyncState(claudeDir: string, state: SyncState): void {
  const statePath = join(claudeDir, STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function discoverJSONLFiles(claudeDir: string): string[] {
  const projectsDir = join(claudeDir, 'projects');
  const files: string[] = [];

  let projectDirs: { name: string; isDirectory: () => boolean }[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true }) as unknown as { name: string; isDirectory: () => boolean }[];
  } catch {
    return [];
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;

    const dirPath = join(projectsDir, entry.name);
    let dirEntries: { name: string; isDirectory: () => boolean }[];
    try {
      dirEntries = readdirSync(dirPath, { withFileTypes: true }) as unknown as { name: string; isDirectory: () => boolean }[];
    } catch {
      continue;
    }

    for (const file of dirEntries) {
      if (!file.isDirectory() && file.name.endsWith('.jsonl')) {
        files.push(join(dirPath, file.name));
      }
    }
  }

  return files;
}

export async function sync(options: SyncOptions): Promise<SyncResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const state = options.full ? {} : loadSyncState(options.claudeDir);
  const newState: SyncState = { ...state };

  const result: SyncResult = {
    filesProcessed: 0,
    exchangesParsed: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
  };

  const allFiles = discoverJSONLFiles(options.claudeDir);

  for (const filePath of allFiles) {
    const mtime = statSync(filePath).mtimeMs;

    // Skip unchanged files in incremental mode
    if (!options.full && state[filePath] !== undefined && state[filePath] >= mtime) {
      continue;
    }

    // Extract project name from directory
    const dirName = filePath.split('/').slice(-2, -1)[0];
    const projectName = extractProjectName(dirName);

    // Filter by project if specified
    if (options.project && projectName !== options.project) {
      continue;
    }

    let exchanges: Exchange[];
    try {
      exchanges = readAndParseJSONLFile(filePath);
    } catch {
      result.errors++;
      continue;
    }

    // Set project name on all exchanges
    for (const exc of exchanges) {
      exc.project = projectName;
    }

    result.filesProcessed++;
    result.exchangesParsed += exchanges.length;

    if (!options.dryRun && exchanges.length > 0) {
      // Batch upload
      for (let i = 0; i < exchanges.length; i += BATCH_SIZE) {
        const batch = exchanges.slice(i, i + BATCH_SIZE);
        try {
          const response = await fetchFn(`${options.apiUrl}/api/import`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.apiToken}`,
            },
            body: JSON.stringify({ exchanges: batch }),
          });

          if (response.ok) {
            const body = (await response.json()) as { imported: number; skipped: number; errors: { index: number; error: string }[] };
            result.imported += body.imported;
            result.skipped += body.skipped;
            result.errors += body.errors.length;
          } else {
            result.errors += batch.length;
          }
        } catch {
          result.errors += batch.length;
        }
      }
    }

    // Update sync state
    newState[filePath] = mtime;
  }

  if (!options.dryRun) {
    saveSyncState(options.claudeDir, newState);
  }

  return result;
}
