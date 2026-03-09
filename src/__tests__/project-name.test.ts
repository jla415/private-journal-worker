// ABOUTME: Tests for project name extraction from .claude/projects/ directory paths
// ABOUTME: RED tests written first per TDD approach

import { describe, it, expect } from 'vitest';
import { extractProjectName } from '../sync/project-name';

describe('extractProjectName', () => {
  it('should extract simple project name', () => {
    expect(extractProjectName('-Users-xd-code-private-journal-worker')).toBe('private-journal-worker');
  });

  it('should extract nested project name', () => {
    expect(extractProjectName('-Users-xd-code-trading-tradebot')).toBe('tradebot');
  });

  it('should handle worktree paths by extracting base project', () => {
    expect(extractProjectName('-Users-xd-code-trading-tradebot-worktrees-tradebot-codex-rust')).toBe('tradebot');
  });

  it('should handle worktree paths with version suffixes', () => {
    expect(extractProjectName('-Users-xd-code-trading-tradebot-worktrees-tradebot-v0iy')).toBe('tradebot');
  });

  it('should handle double-dash home paths', () => {
    expect(extractProjectName('-Users-xd--claude')).toBe('claude');
  });

  it('should handle deep double-dash paths', () => {
    expect(extractProjectName('-Users-xd--superset-worktrees-superset-xdd-5-test-task')).toBe('superset');
  });

  it('should use cwd fallback for ambiguous paths', () => {
    // alpaca-hybrid could be its own project or a branch of tradebot
    expect(extractProjectName(
      '-Users-xd-code-trading-tradebot-alpaca-hybrid',
      '/Users/xd/code/trading/tradebot-alpaca-hybrid'
    )).toBe('tradebot-alpaca-hybrid');
  });

  it('should extract from cwd when provided', () => {
    expect(extractProjectName(
      '-Users-xd-code-my-proj',
      '/Users/xd/code/my-proj'
    )).toBe('my-proj');
  });
});
