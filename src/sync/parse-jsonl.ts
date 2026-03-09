// ABOUTME: Parses Claude Code conversation JSONL files into exchange pairs
// ABOUTME: Pure function taking raw JSONL string, no file I/O

import { readFileSync } from 'node:fs';

export interface Exchange {
  user_message: string;
  assistant_message: string;
  tool_names: string[];
  session_id: string;
  project: string;
  timestamp: number;
}

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

interface ConversationRecord {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string;
  sessionId: string;
  timestamp: string;
  cwd: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
  };
  toolUseResult?: unknown;
}

export function extractTextContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('');
}

export function extractToolNames(blocks: ContentBlock[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && b.name && !seen.has(b.name)) {
      seen.add(b.name);
      names.push(b.name);
    }
  }
  return names;
}

export function parseJSONL(content: string): Exchange[] {
  // Parse all lines, skipping malformed JSON
  const records: ConversationRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // Only keep conversation records (user/assistant with a message)
      if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.message) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Build lookup maps
  const byUuid = new Map<string, ConversationRecord>();
  const childrenOf = new Map<string, ConversationRecord[]>();

  for (const rec of records) {
    byUuid.set(rec.uuid, rec);
    const siblings = childrenOf.get(rec.parentUuid) ?? [];
    siblings.push(rec);
    childrenOf.set(rec.parentUuid, siblings);
  }

  // Find "real" user messages (not tool results)
  const realUserMessages = records.filter(
    (r) => r.type === 'user' && r.message?.role === 'user' && typeof r.message.content === 'string' && !r.toolUseResult
  );

  const exchanges: Exchange[] = [];

  for (const userRec of realUserMessages) {
    // Filter guarantees message exists and content is string
    const userMessage = String(userRec.message!.content);
    const allTextBlocks: string[] = [];
    const allToolNames: string[] = [];
    const toolNamesSeen = new Set<string>();

    // Walk the chain of responses: follow children from this user message
    // through any tool call/result cycles until we reach a terminal assistant response
    const visited = new Set<string>();
    const queue = [userRec.uuid];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = childrenOf.get(parentId) ?? [];

      for (const child of children) {
        if (visited.has(child.uuid)) continue;
        visited.add(child.uuid);

        if (child.type === 'assistant' && child.message?.role === 'assistant') {
          if (typeof child.message.content === 'string') continue;
          const blocks = child.message.content;
          const text = extractTextContent(blocks);
          if (text) allTextBlocks.push(text);

          for (const name of extractToolNames(blocks)) {
            if (!toolNamesSeen.has(name)) {
              toolNamesSeen.add(name);
              allToolNames.push(name);
            }
          }

          // Continue following the chain (tool results may follow)
          queue.push(child.uuid);
        } else if (child.type === 'user' && child.toolUseResult) {
          // Tool result — continue following the chain
          queue.push(child.uuid);
        }
        // If it's a real user message (not tool result), it starts a new exchange — don't follow
      }
    }

    const assistantMessage = allTextBlocks.join('\n\n');

    // Skip empty exchanges
    if (!userMessage && !assistantMessage) continue;

    exchanges.push({
      user_message: userMessage,
      assistant_message: assistantMessage,
      tool_names: allToolNames,
      session_id: userRec.sessionId,
      project: '',  // Filled in by the sync orchestrator from directory path
      timestamp: new Date(userRec.timestamp).getTime(),
    });
  }

  return exchanges;
}

export function readAndParseJSONLFile(filePath: string): Exchange[] {
  const content = readFileSync(filePath, 'utf-8');
  return parseJSONL(content);
}
