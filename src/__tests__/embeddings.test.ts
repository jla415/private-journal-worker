// ABOUTME: Tests for embedding generation and text extraction
// ABOUTME: Covers Workers AI mock calls and searchable text building

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateEmbedding, generateEmbeddings, extractSearchableText } from '../embeddings';
import { createMockEnv } from './mocks';
import { Env } from '../types';

describe('embeddings', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe('generateEmbedding', () => {
    it('should call AI.run with correct model and text', async () => {
      const result = await generateEmbedding(env, 'test query');

      expect(env.AI.run).toHaveBeenCalledWith('@cf/baai/bge-m3', {
        text: ['test query'],
      });
      expect(result).toEqual(Array(1024).fill(0.1));
    });

    it('should return the first embedding from the response', async () => {
      const mockEmbedding = [0.5, 0.6, 0.7];
      (env.AI.run as any).mockResolvedValue({ data: [mockEmbedding, [0.1, 0.2]] });

      const result = await generateEmbedding(env, 'test');
      expect(result).toEqual(mockEmbedding);
    });
  });

  describe('generateEmbeddings', () => {
    it('should return empty array for empty input', async () => {
      const result = await generateEmbeddings(env, []);
      expect(result).toEqual([]);
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it('should pass multiple texts to AI.run', async () => {
      const embeddings = [[0.1], [0.2], [0.3]];
      (env.AI.run as any).mockResolvedValue({ data: embeddings });

      const result = await generateEmbeddings(env, ['a', 'b', 'c']);

      expect(env.AI.run).toHaveBeenCalledWith('@cf/baai/bge-m3', {
        text: ['a', 'b', 'c'],
      });
      expect(result).toEqual(embeddings);
    });
  });

  describe('extractSearchableText', () => {
    it('should prepend section names to content', () => {
      const result = extractSearchableText('Some content', ['Feelings', 'Project Notes']);
      expect(result).toBe('Sections: Feelings, Project Notes. Some content');
    });

    it('should handle empty sections', () => {
      const result = extractSearchableText('Some content', []);
      expect(result).toBe('Some content');
    });

    it('should handle single section', () => {
      const result = extractSearchableText('Content', ['Technical Insights']);
      expect(result).toBe('Sections: Technical Insights. Content');
    });
  });
});
