// ABOUTME: Read entry tool - fetches full content of a journal entry
// ABOUTME: Uses entry ID as path for remote entries

import { Env, ReadEntryParams } from '../types';
import { getEntry } from '../db';

export async function handleReadEntry(
  args: Record<string, unknown>,
  env: Env
): Promise<{ content: string; timestamp: number; sections: string[] } | { error: string }> {
  const path = args['path'];
  if (typeof path !== 'string') {
    return { error: 'path is required and must be a string' };
  }
  const params: ReadEntryParams = { path };

  const entry = await getEntry(env, params.path);
  if (!entry) {
    return { error: `Entry not found: ${params.path}` };
  }

  const sections: string[] = JSON.parse(entry.sections);

  return {
    content: entry.content,
    timestamp: entry.timestamp,
    sections,
  };
}
