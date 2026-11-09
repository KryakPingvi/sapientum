import type { AccessGrant } from '@sapientum/contracts/sessions';
import type { SessionService, SessionGrant } from '../application/session-service.js';
import { SessionError } from '../domain/session.js';

export interface SessionHttpRequest {
  method: string;
  url: string;
  body?: unknown;
  /** Host extracts Bearer token; identity is never accepted from body. */
  accessToken: string;
  /** Host extracts __Secure-sapientum-refresh HttpOnly cookie. */
  refreshToken: string;
  /** Host checks configured exact Origin AND CSRF token on all mutations, including login. */
  csrfVerified: boolean;
  userAgent: string;
  ip: string;
}

export interface SessionHttpResponse {
  status: number;
  body: unknown;
  headers: { 'Cache-Control': 'no-store' };
  /** Host must apply as Secure, HttpOnly, SameSite=Strict, Path=/auth, no Domain. Not part of JSON. */
  refreshCookie?: { value: string; expiresAt: string } | null;
}

export function createSessionRoutes(service: SessionService) {
  return async (request: SessionHttpRequest): Promise<SessionHttpResponse> => {
    const response = (status: number, body: unknown): SessionHttpResponse => ({
      status,
      body,
      headers: { 'Cache-Control': 'no-store' },
    });
    const granted = (grant: SessionGrant): SessionHttpResponse => {
      const body: AccessGrant = {
        accessToken: grant.accessToken,
        expiresAt: grant.expiresAt,
        sessionId: grant.sessionId,
      };
      return {
        ...response(200, body),
        refreshCookie: { value: grant.refreshToken, expiresAt: grant.refreshExpiresAt },
      };
    };
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const match = /^\/auth\/(login|refresh|sessions)(?:\/([^/]+))?$/.exec(path);
      if (!match || (match[2] && match[1] !== 'sessions')) return response(404, { code: 'NOT_FOUND' });
      const action = match[1];
      const id = match[2] ? decodeURIComponent(match[2]) : null;
      const readable = action === 'sessions' && id === null && request.method === 'GET';
      const writable =
        (action === 'sessions' && request.method === 'DELETE') || (action !== 'sessions' && request.method === 'POST');
      if (!readable && !writable) return response(405, { code: 'METHOD_NOT_ALLOWED' });
      if (writable && !request.csrfVerified) return response(403, { code: 'CSRF_REJECTED' });
      if (action === 'login') {
        const body = request.body;
        if (typeof body !== 'object' || body === null || Array.isArray(body))
          throw new SessionError('INVALID_INPUT', 'Expected a JSON object.');
        const fields = body as Record<string, unknown>;
        return granted(
          await service.login({
            login: fields.login,
            password: fields.password,
            deviceLabel: fields.deviceLabel,
            userAgent: request.userAgent,
            ip: request.ip,
          }),
        );
      }
      if (action === 'refresh') return granted(await service.refresh(request.refreshToken));
      if (readable) return response(200, await service.list(request.accessToken));
      const currentRevoked = await service.revoke(request.accessToken, id);
      return { ...response(204, null), ...(currentRevoked ? { refreshCookie: null } : {}) };
    } catch (error) {
      if (error instanceof SessionError)
        return response(({ INVALID_INPUT: 400, UNAUTHENTICATED: 401, NOT_FOUND: 404 } as const)[error.code], {
          code: error.code,
        });
      if (error instanceof URIError) return response(400, { code: 'INVALID_INPUT' });
      throw error;
    }
  };
}
