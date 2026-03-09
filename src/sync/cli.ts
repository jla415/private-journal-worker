#!/usr/bin/env node
// ABOUTME: CLI entry point for journal-sync
// ABOUTME: Thin wrapper around sync orchestrator using process.argv

import { sync } from './sync';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: journal-sync [options]

Options:
  --full        Re-sync all files (ignore incremental state)
  --dry-run     Parse and count without uploading
  --project X   Only sync files for project X
  --url URL     API URL (default: JOURNAL_API_URL env var)
  --token TOK   API token (default: JOURNAL_TOKEN env var)
  --help        Show this help`);
    process.exit(0);
  }

  const claudeDir = join(homedir(), '.claude');
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');

  let project: string | undefined;
  const projectIdx = args.indexOf('--project');
  if (projectIdx !== -1 && args[projectIdx + 1]) {
    project = args[projectIdx + 1];
  }

  let apiUrl = process.env['JOURNAL_API_URL'] ?? '';
  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    apiUrl = args[urlIdx + 1];
  }

  let apiToken = process.env['JOURNAL_TOKEN'] ?? '';
  const tokenIdx = args.indexOf('--token');
  if (tokenIdx !== -1 && args[tokenIdx + 1]) {
    apiToken = args[tokenIdx + 1];
  }

  if (!apiUrl) {
    console.error('Error: API URL required. Set JOURNAL_API_URL or use --url');
    process.exit(1);
  }

  if (!apiToken && !dryRun) {
    console.error('Error: API token required. Set JOURNAL_TOKEN or use --token');
    process.exit(1);
  }

  console.log(`Syncing from ${claudeDir}/projects/`);
  if (dryRun) console.log('(dry run — no uploads)');
  if (full) console.log('(full sync — ignoring incremental state)');
  if (project) console.log(`(filtering to project: ${project})`);

  const result = await sync({
    claudeDir,
    apiUrl,
    apiToken,
    dryRun,
    full,
    project,
  });

  console.log(`\nResults:`);
  console.log(`  Files processed: ${result.filesProcessed}`);
  console.log(`  Exchanges parsed: ${result.exchangesParsed}`);
  console.log(`  Imported: ${result.imported}`);
  console.log(`  Skipped (dupes): ${result.skipped}`);
  console.log(`  Errors: ${result.errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
