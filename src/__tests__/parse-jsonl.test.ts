// ABOUTME: Tests for JSONL parser that extracts exchanges from Claude Code conversation files
// ABOUTME: RED tests written first per TDD approach

import { describe, it, expect } from 'vitest';
import { parseJSONL, extractTextContent, extractToolNames, ContentBlock } from '../sync/parse-jsonl';

function makeRecord(overrides: Record<string, unknown>) {
  return {
    type: 'user',
    uuid: 'uuid-1',
    parentUuid: 'uuid-0',
    sessionId: 'session-1',
    timestamp: '2026-03-08T12:00:00.000Z',
    cwd: '/Users/xd/code/my-project',
    ...overrides,
  };
}

function userRecord(content: string, uuid: string, parentUuid: string) {
  return JSON.stringify(makeRecord({
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content },
  }));
}

function assistantRecord(contentBlocks: unknown[], uuid: string, parentUuid: string) {
  return JSON.stringify(makeRecord({
    type: 'assistant',
    uuid,
    parentUuid,
    message: { role: 'assistant', content: contentBlocks },
  }));
}

function toolResultRecord(uuid: string, parentUuid: string) {
  return JSON.stringify(makeRecord({
    type: 'user',
    uuid,
    parentUuid,
    toolUseResult: { stdout: 'output', stderr: '', interrupted: false },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'output' }],
    },
  }));
}

describe('parseJSONL', () => {
  it('should filter out non-conversation records', () => {
    const lines = [
      JSON.stringify({ type: 'progress', subtype: 'hook' }),
      JSON.stringify({ type: 'file-history-snapshot', isSnapshotUpdate: true, snapshot: {} }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      userRecord('hello', 'u1', 'root'),
      assistantRecord([{ type: 'text', text: 'hi there' }], 'a1', 'u1'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].user_message).toBe('hello');
  });

  it('should pair user messages with assistant responses via parentUuid', () => {
    const lines = [
      userRecord('first question', 'u1', 'root'),
      assistantRecord([{ type: 'text', text: 'first answer' }], 'a1', 'u1'),
      userRecord('second question', 'u2', 'a1'),
      assistantRecord([{ type: 'text', text: 'second answer' }], 'a2', 'u2'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].user_message).toBe('first question');
    expect(exchanges[0].assistant_message).toBe('first answer');
    expect(exchanges[1].user_message).toBe('second question');
    expect(exchanges[1].assistant_message).toBe('second answer');
  });

  it('should skip thinking blocks and extract only text content', () => {
    const lines = [
      userRecord('question', 'u1', 'root'),
      assistantRecord([
        { type: 'thinking', thinking: 'let me think about this...' },
        { type: 'text', text: 'the answer is 42' },
      ], 'a1', 'u1'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    expect(exchanges[0].assistant_message).toBe('the answer is 42');
    expect(exchanges[0].assistant_message).not.toContain('think');
  });

  it('should collect tool names from tool_use blocks', () => {
    const lines = [
      userRecord('fix the bug', 'u1', 'root'),
      assistantRecord([
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo' } },
      ], 'a1', 'u1'),
      toolResultRecord('tr1', 'a1'),
      assistantRecord([
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
      ], 'a2', 'tr1'),
      toolResultRecord('tr2', 'a2'),
      assistantRecord([
        { type: 'text', text: 'Fixed it!' },
      ], 'a3', 'tr2'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].tool_names).toEqual(['Read', 'Bash']);
    expect(exchanges[0].assistant_message).toContain('Let me check.');
    expect(exchanges[0].assistant_message).toContain('Fixed it!');
  });

  it('should group multi-turn tool exchanges into a single logical exchange', () => {
    const lines = [
      userRecord('deploy the app', 'u1', 'root'),
      assistantRecord([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } },
      ], 'a1', 'u1'),
      toolResultRecord('tr1', 'a1'),
      assistantRecord([
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run deploy' } },
      ], 'a2', 'tr1'),
      toolResultRecord('tr2', 'a2'),
      assistantRecord([
        { type: 'text', text: 'Deployed successfully.' },
      ], 'a3', 'tr2'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    // Should be a single exchange, not 3 separate ones
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].user_message).toBe('deploy the app');
    expect(exchanges[0].assistant_message).toContain('Deployed successfully.');
  });

  it('should extract session ID and timestamp', () => {
    const lines = [
      userRecord('hello', 'u1', 'root'),
      assistantRecord([{ type: 'text', text: 'hi' }], 'a1', 'u1'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    expect(exchanges[0].session_id).toBe('session-1');
    expect(exchanges[0].timestamp).toBe(new Date('2026-03-08T12:00:00.000Z').getTime());
  });

  it('should handle assistant with only thinking (no text output)', () => {
    const lines = [
      userRecord('think about this', 'u1', 'root'),
      assistantRecord([
        { type: 'thinking', thinking: 'deep thoughts...' },
      ], 'a1', 'u1'),
      userRecord('next question', 'u2', 'a1'),
      assistantRecord([{ type: 'text', text: 'answer' }], 'a2', 'u2'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    // The thinking-only exchange should be skipped (no useful content)
    const nonEmpty = exchanges.filter(e => e.assistant_message.length > 0);
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0].user_message).toBe('next question');
  });

  it('should handle empty content gracefully', () => {
    const lines = [
      userRecord('', 'u1', 'root'),
      assistantRecord([], 'a1', 'u1'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    // Empty exchanges should be filtered out
    const nonEmpty = exchanges.filter(e => e.user_message.length > 0 || e.assistant_message.length > 0);
    expect(nonEmpty).toHaveLength(0);
  });

  it('should skip malformed JSON lines', () => {
    const lines = [
      'not valid json',
      userRecord('hello', 'u1', 'root'),
      '{broken',
      assistantRecord([{ type: 'text', text: 'hi' }], 'a1', 'u1'),
    ].join('\n');

    const exchanges = parseJSONL(lines);
    expect(exchanges).toHaveLength(1);
  });
});

describe('extractTextContent', () => {
  it('should extract text blocks only', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'hello ' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', text: 'world' },
    ];
    expect(extractTextContent(blocks)).toBe('hello world');
  });

  it('should return empty string for no text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ];
    expect(extractTextContent(blocks)).toBe('');
  });
});

describe('extractToolNames', () => {
  it('should collect unique tool names', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', text: 'some text' },
      { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
      { type: 'tool_use', id: 't3', name: 'Read', input: {} },
    ];
    expect(extractToolNames(blocks)).toEqual(['Read', 'Bash']);
  });

  it('should return empty array when no tools used', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }];
    expect(extractToolNames(blocks)).toEqual([]);
  });
});
