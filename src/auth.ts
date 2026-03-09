// ABOUTME: Authentication middleware for Bearer token and OAuth validation
// ABOUTME: Checks both static JOURNAL_TOKEN and OAuth tokens in D1

import { Env, OAuthTokenRow } from './types';

export interface AuthResult {
  valid: boolean;
  clientId?: string;
  scope?: string;
  authSource?: 'static' | 'oauth';
}

function timingSafeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

export function hasScope(authResult: AuthResult, requiredScope: string): boolean {
  if (!authResult.scope) return false;
  return authResult.scope.split(' ').includes(requiredScope);
}

export async function validateAuth(request: Request, env: Env): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false };
  }

  const token = authHeader.slice(7);

  // Check static bearer token (for CLI)
  if (env.JOURNAL_TOKEN && timingSafeCompare(token, env.JOURNAL_TOKEN)) {
    return { valid: true, scope: 'journal:read journal:write', authSource: 'static' };
  }

  // Check OAuth token in D1
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    'SELECT client_id, scope, expires_at FROM oauth_tokens WHERE token = ? AND expires_at > ?'
  )
    .bind(token, now)
    .first<OAuthTokenRow>();

  if (result) {
    return {
      valid: true,
      clientId: result.client_id,
      scope: result.scope,
      authSource: 'oauth',
    };
  }

  return { valid: false };
}
