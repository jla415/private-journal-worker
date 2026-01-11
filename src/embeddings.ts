// ABOUTME: Workers AI embedding generation using bge-m3
// ABOUTME: Generates 1024-dimensional vectors for semantic search

import { Env } from './types';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';

export async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  const response = await env.AI.run(EMBEDDING_MODEL, {
    text: [text],
  });

  // Workers AI returns { data: [[...numbers]] }
  const data = response as { data: number[][] };
  return data.data[0];
}

export async function generateEmbeddings(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await env.AI.run(EMBEDDING_MODEL, {
    text: texts,
  });

  const data = response as { data: number[][] };
  return data.data;
}

// Extract searchable text from journal content
export function extractSearchableText(content: string, sections: string[]): string {
  // Combine section names with content for better semantic matching
  const sectionPrefix = sections.length > 0 ? `Sections: ${sections.join(', ')}. ` : '';
  return sectionPrefix + content;
}
