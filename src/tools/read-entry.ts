// ABOUTME: Read entry tool - fetches full content of a journal entry or exchange
// ABOUTME: Detects exc- prefix to route to exchanges table

import { Env } from '../types';
import { getEntry, getExchange } from '../db';

export async function handleReadEntry(
  args: Record<string, unknown>,
  env: Env
): Promise<{ content: string; timestamp: number; sections?: string[]; source: 'journal' | 'chat'; session_id?: string; project?: string } | { error: string }> {
  // Support both 'id' (new) and 'path' (deprecated) parameter names
  const id = args['id'] ?? args['path'];
  if (typeof id !== 'string') {
    return { error: 'id is required and must be a string' };
  }

  // Route based on ID prefix
  if (id.startsWith('exc-')) {
    const exchange = await getExchange(env, id);
    if (!exchange) {
      return { error: `Exchange not found: ${id}` };
    }
    return {
      content: `## User\n\n${exchange.user_message}\n\n## Assistant\n\n${exchange.assistant_message}`,
      timestamp: exchange.timestamp,
      source: 'chat',
      session_id: exchange.session_id ?? undefined,
      project: exchange.project ?? undefined,
    };
  }

  const entry = await getEntry(env, id);
  if (!entry) {
    return { error: `Entry not found: ${id}` };
  }

  const sections: string[] = JSON.parse(entry.sections);

  return {
    content: entry.content,
    timestamp: entry.timestamp,
    sections,
    source: 'journal',
    project: entry.project ?? undefined,
  };
}
