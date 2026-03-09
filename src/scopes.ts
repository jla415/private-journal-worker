// ABOUTME: Scope constants for journal access control
// ABOUTME: Single source of truth for OAuth scope strings

export const SCOPE_READ = 'journal:read';
export const SCOPE_WRITE = 'journal:write';
export const SCOPE_ALL = `${SCOPE_READ} ${SCOPE_WRITE}`;
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE];
