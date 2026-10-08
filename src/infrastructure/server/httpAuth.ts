/**
 * HTTP bearer-token authentication shared by the REST, WebSocket upgrade, SSE and
 * debug endpoints of the HTTP server.
 */

import { isBlankToken } from '../../config/auth';
import { constantTimeEqual } from '../../shared/hash';
import { jsonResponse } from './httpEndpoints';

/**
 * Validate auth token against valid tokens set, both sides trimmed (as the TCP `Auth`
 * command compares them). A missing header reads as `''`, so a blank presented or
 * configured token never matches, even if one reached the set (config validation
 * already refuses it): an empty token must not authenticate.
 */
function validateAuthToken(token: string, authTokens: Set<string>): boolean {
  if (isBlankToken(token)) return false;
  const presented = token.trim();
  for (const validToken of authTokens) {
    if (!isBlankToken(validToken) && constantTimeEqual(presented, validToken.trim())) {
      return true;
    }
  }
  return false;
}

/** Check auth and return 401 response if invalid, or null if OK */
export function checkAuth(req: Request, authTokens: Set<string>): Response | null {
  if (authTokens.size === 0) return null;
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  if (!validateAuthToken(token, authTokens)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }
  return null;
}
