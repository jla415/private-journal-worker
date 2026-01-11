// ABOUTME: Authentication middleware for OAuth token validation
// ABOUTME: Validates OAuth access tokens stored in D1

import { Env, OAuthTokenRow } from './types';

export interface AuthResult {
  valid: boolean;
  clientId?: string;
  scope?: string;
}

export async function validateAuth(request: Request, env: Env): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false };
  }

  const token = authHeader.slice(7);

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
    };
  }

  return { valid: false };
}
