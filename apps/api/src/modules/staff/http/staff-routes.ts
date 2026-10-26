import type { StaffService } from '../application/staff-service.js';
import { StaffError } from '../domain/staff-error.js';

export interface StaffHttpRequest {
  method: string;
  url: string;
  body?: unknown;
  /** Must be provided by trusted session middleware, never from request body/headers. */
  principal: { userId: string } | null;
}

export interface StaffHttpResponse {
  status: number;
  body: unknown;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StaffError('INVALID_INPUT', 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

const ERROR_STATUS = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  DUPLICATE_MEMBER: 409,
  MEMBER_EXCLUDED: 409,
  LAST_ADMINISTRATOR: 409,
  VERSION_CONFLICT: 409,
  ALREADY_INITIALIZED: 409,
} as const;

/** Framework-independent HTTP adapter; authentication and JSON parsing belong to the host server. */
export function createStaffRoutes(service: StaffService) {
  return (request: StaffHttpRequest): StaffHttpResponse => {
    if (!request.principal) return { status: 401, body: { code: 'UNAUTHENTICATED' } };
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = /^\/tournaments\/([^/]+)\/staff(?:\/([^/]+)(\/roles|\/exclude)?)?$/.exec(url.pathname);
      if (!match) return { status: 404, body: { code: 'NOT_FOUND' } };
      const tournamentId = decodeURIComponent(match[1]!);
      const memberId = match[2] ? decodeURIComponent(match[2]) : undefined;
      const actorId = request.principal.userId;
      if (!memberId && request.method === 'GET') {
        const status = url.searchParams.get('status') ?? 'active';
        if (status !== 'active' && status !== 'excluded') throw new StaffError('INVALID_INPUT', 'Unknown status.');
        return { status: 200, body: service.list({ actorId, tournamentId, status }) };
      }
      if (!memberId && request.method === 'POST') {
        const body = objectBody(request.body);
        if (typeof body.userId !== 'string') throw new StaffError('INVALID_INPUT', 'userId is required.');
        return { status: 201, body: service.add({ actorId, tournamentId, userId: body.userId, roles: body.roles }) };
      }
      if (
        memberId &&
        ((match[3] === '/roles' && request.method === 'PUT') || (match[3] === '/exclude' && request.method === 'POST'))
      ) {
        const body = objectBody(request.body);
        if (
          typeof body.expectedVersion !== 'number' ||
          !Number.isInteger(body.expectedVersion) ||
          body.expectedVersion < 1
        ) {
          throw new StaffError('INVALID_INPUT', 'expectedVersion must be a positive integer.');
        }
        const input = { actorId, tournamentId, memberId, expectedVersion: body.expectedVersion };
        return {
          status: 200,
          body: match[3] === '/roles' ? service.setRoles({ ...input, roles: body.roles }) : service.exclude(input),
        };
      }
      return { status: 405, body: { code: 'METHOD_NOT_ALLOWED' } };
    } catch (error) {
      if (error instanceof StaffError)
        return { status: ERROR_STATUS[error.code], body: { code: error.code, message: error.message } };
      if (error instanceof URIError) return { status: 400, body: { code: 'INVALID_INPUT' } };
      throw error;
    }
  };
}
