// ABOUTME: Process thoughts tool - writes journal entries
// ABOUTME: Generates embeddings and stores in D1 + Vectorize

import { Env, ProcessThoughtsParams } from '../types';
import { insertEntry } from '../db';
import { generateEmbedding, extractSearchableText } from '../embeddings';

export async function handleProcessThoughts(
  args: Record<string, unknown>,
  env: Env
): Promise<{ success: boolean; id: string }> {
  const params = args as ProcessThoughtsParams;

  // Build content from provided sections
  const sections: string[] = [];
  const contentParts: string[] = [];

  if (params.feelings) {
    sections.push('Feelings');
    contentParts.push(`## Feelings\n\n${params.feelings}`);
  }
  if (params.project_notes) {
    sections.push('Project Notes');
    contentParts.push(`## Project Notes\n\n${params.project_notes}`);
  }
  if (params.user_context) {
    sections.push('User Context');
    contentParts.push(`## User Context\n\n${params.user_context}`);
  }
  if (params.technical_insights) {
    sections.push('Technical Insights');
    contentParts.push(`## Technical Insights\n\n${params.technical_insights}`);
  }
  if (params.world_knowledge) {
    sections.push('World Knowledge');
    contentParts.push(`## World Knowledge\n\n${params.world_knowledge}`);
  }

  if (contentParts.length === 0) {
    throw new Error('At least one section must be provided');
  }

  const content = contentParts.join('\n\n');
  const now = Date.now();
  const date = new Date(now).toISOString().split('T')[0];

  // Generate unique ID from timestamp + content hash
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content + now.toString())
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const id = `${date}-${now}-${hash}`;

  // Generate embedding
  const searchableText = extractSearchableText(content, sections);
  const embedding = await generateEmbedding(env, searchableText);

  // Store in D1
  await insertEntry(env, {
    id,
    timestamp: now,
    date,
    project: null,
    sections,
    content,
  });

  // Store in Vectorize
  await env.VECTORIZE.upsert([
    {
      id,
      values: embedding,
      metadata: {
        timestamp: now,
        date,
        sections: sections.join(','),
      },
    },
  ]);

  return { success: true, id };
}
