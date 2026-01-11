#!/usr/bin/env npx ts-node
// ABOUTME: Import script for existing local journal entries
// ABOUTME: Reads from ~/.claude-journals/ and uploads to Cloudflare Worker

import * as fs from 'fs';
import * as path from 'path';

const WORKER_URL = 'https://private-journal.jla415.workers.dev/mcp';
const CENTRAL_JOURNAL_DIR = path.join(process.env.HOME || '', '.claude-journals');

interface JournalEntry {
  filePath: string;
  date: string;
  timestamp: number;
  project: string | null;
  sections: Record<string, string>;
  content: string;
}

function parseYamlFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: match[2] };
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const sectionRegex = /^## (.+)$/gm;

  let lastSection: string | null = null;
  let lastIndex = 0;
  let match;

  while ((match = sectionRegex.exec(body)) !== null) {
    if (lastSection !== null) {
      sections[lastSection] = body.slice(lastIndex, match.index).trim();
    }
    lastSection = match[1];
    lastIndex = match.index + match[0].length;
  }

  if (lastSection !== null) {
    sections[lastSection] = body.slice(lastIndex).trim();
  }

  return sections;
}

function sectionNameToKey(name: string): string {
  const mapping: Record<string, string> = {
    'Feelings': 'feelings',
    'Project Notes': 'project_notes',
    'User Context': 'user_context',
    'Technical Insights': 'technical_insights',
    'World Knowledge': 'world_knowledge',
  };
  return mapping[name] || name.toLowerCase().replace(/\s+/g, '_');
}

// Scan a project journal directory (contains date folders like 2025-12-13/)
function scanProjectDir(projectDir: string, projectName: string | null): JournalEntry[] {
  const entries: JournalEntry[] = [];

  if (!fs.existsSync(projectDir)) {
    return entries;
  }

  // Get all date directories
  const dates = fs.readdirSync(projectDir).filter((name: string) => {
    const stat = fs.statSync(path.join(projectDir, name));
    return stat.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(name);
  });

  for (const date of dates) {
    const dateDir = path.join(projectDir, date);

    // Get all .md files
    const files = fs.readdirSync(dateDir).filter((name: string) => name.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(dateDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseYamlFrontmatter(content);
      const sections = parseSections(body);

      // Convert section names to keys
      const sectionData: Record<string, string> = {};
      for (const [name, text] of Object.entries(sections)) {
        sectionData[sectionNameToKey(name)] = text;
      }

      entries.push({
        filePath,
        date,
        timestamp: parseInt(frontmatter['timestamp'] || '0', 10),
        project: projectName,
        sections: sectionData,
        content,
      });
    }
  }

  return entries;
}

async function findAllEntries(skipCentral: boolean, additionalDirs: string[], projectOverride: string | null): Promise<JournalEntry[]> {
  const entries: JournalEntry[] = [];

  // Scan centralized journal directory
  if (!skipCentral && fs.existsSync(CENTRAL_JOURNAL_DIR)) {
    const projects = fs.readdirSync(CENTRAL_JOURNAL_DIR).filter((name: string) => {
      const stat = fs.statSync(path.join(CENTRAL_JOURNAL_DIR, name));
      return stat.isDirectory() && !name.startsWith('.');
    });

    for (const project of projects) {
      const projectDir = path.join(CENTRAL_JOURNAL_DIR, project);
      const projectName = project === 'user' ? null : project;
      entries.push(...scanProjectDir(projectDir, projectName));
    }
  }

  // Scan additional project directories (e.g., ~/code/project/.private-journal)
  for (const dir of additionalDirs) {
    if (!fs.existsSync(dir)) {
      console.error(`Directory not found: ${dir}`);
      continue;
    }

    // Use override or extract project name from parent directory
    const projectName = projectOverride || path.basename(path.dirname(dir));
    console.log(`Scanning ${dir} as project: ${projectName}`);
    entries.push(...scanProjectDir(dir, projectName));
  }

  // Sort by timestamp
  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

async function uploadEntry(entry: JournalEntry, token: string): Promise<boolean> {
  const params: Record<string, string> = {};

  for (const [key, value] of Object.entries(entry.sections)) {
    if (value) {
      params[key] = value;
    }
  }

  // Skip entries with no actual content
  if (Object.keys(params).length === 0) {
    return true; // Skip silently
  }

  // Preserve original timestamp, date, and project
  params['_timestamp'] = entry.timestamp.toString();
  params['_date'] = entry.date;
  if (entry.project) {
    params['_project'] = entry.project;
  }

  const body = {
    jsonrpc: '2.0',
    id: entry.timestamp,
    method: 'tools/call',
    params: {
      name: 'process_thoughts',
      arguments: params,
    },
  };

  try {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Failed to upload ${entry.filePath}: ${response.status} ${text}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`Error uploading ${entry.filePath}:`, err);
    return false;
  }
}

async function main() {
  const token = process.env.JOURNAL_TOKEN;
  const dryRun = process.argv.includes('--dry-run');
  const skipCentral = process.argv.includes('--skip-central');

  // Parse --project flag for overriding project name
  const projectIdx = process.argv.indexOf('--project');
  const projectOverride = projectIdx !== -1 ? process.argv[projectIdx + 1] : null;

  // Get additional directories from command line (non-flag arguments after script name)
  const additionalDirs = process.argv.slice(2).filter(arg =>
    !arg.startsWith('--') && arg !== projectOverride
  );

  console.log('Finding local journal entries...');
  const entries = await findAllEntries(skipCentral, additionalDirs, projectOverride);
  console.log(`Found ${entries.length} entries`);

  if (entries.length === 0) {
    return;
  }

  // Group by project
  const byProject: Record<string, number> = {};
  for (const entry of entries) {
    const proj = entry.project || 'user';
    byProject[proj] = (byProject[proj] || 0) + 1;
  }
  console.log('\nBy project:');
  for (const [proj, count] of Object.entries(byProject)) {
    console.log(`  ${proj}: ${count} entries`);
  }

  // Show sample
  console.log('\nSample entry:');
  console.log(`  File: ${entries[0].filePath}`);
  console.log(`  Date: ${entries[0].date}`);
  console.log(`  Project: ${entries[0].project || 'user'}`);
  console.log(`  Sections: ${Object.keys(entries[0].sections).join(', ')}`);

  if (dryRun) {
    console.log('\nDry run complete. Use JOURNAL_TOKEN=... to upload.');
    return;
  }

  if (!token) {
    console.error('\nJOURNAL_TOKEN environment variable required (or use --dry-run)');
    process.exit(1);
  }

  // Confirm
  console.log('\nPress Ctrl+C to cancel, or wait 5 seconds to continue...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  let success = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    process.stdout.write(`\rUploading ${i + 1}/${entries.length}: ${entry.date}...`);

    if (await uploadEntry(entry, token)) {
      success++;
    } else {
      failed++;
    }

    // Rate limit: 10 per second
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n\nDone! Uploaded ${success} entries, ${failed} failed.`);
}

main().catch(console.error);
