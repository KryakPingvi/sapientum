import { StaffError } from '../../staff/index.js';
import type { TeamService } from '../application/team-service.js';
import { TeamError } from '../domain/team-error.js';

export interface TeamHttpRequest {
  method: string;
  url: string;
  body?: unknown;
  /** Provided by trusted session middleware. Never read identity from request body. */
  principal: { userId: string } | null;
}

export interface TeamHttpResponse {
  status: number;
  body: unknown;
}

const ERROR_STATUS = {
  INVALID_INPUT: 400,
  USER_NOT_FOUND: 404,
  TOURNAMENT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  REGISTRATION_CLOSED: 409,
  DUPLICATE_NAME: 409,
  ALREADY_CONFIRMED: 409,
} as const;

export function createTeamRoutes(service: TeamService) {
  return async (request: TeamHttpRequest): Promise<TeamHttpResponse> => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = /^\/tournaments\/([^/]+)\/teams(?:\/([^/]+)\/confirm)?$/.exec(url.pathname);
      if (!match) return { status: 404, body: { code: 'NOT_FOUND' } };
      const tournamentId = decodeURIComponent(match[1]!);
      const teamId = match[2] ? decodeURIComponent(match[2]) : undefined;
      if (!teamId && request.method === 'GET') {
        return {
          status: 200,
          body: await service.list({ tournamentId, status: url.searchParams.get('status') ?? 'all' }),
        };
      }
      if (request.method !== 'POST') return { status: 405, body: { code: 'METHOD_NOT_ALLOWED' } };
      if (!request.principal) return { status: 401, body: { code: 'UNAUTHENTICATED' } };
      const actorId = request.principal.userId;
      if (teamId) return { status: 200, body: await service.confirm({ actorId, tournamentId, teamId }) };
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new TeamError('INVALID_INPUT', 'Expected a JSON object.');
      }
      const fields = body as Record<string, unknown>;
      return {
        status: 201,
        body: await service.submit({
          actorId,
          tournamentId,
          name: fields.name,
          organization: fields.organization,
          leaderName: fields.leaderName,
        }),
      };
    } catch (error) {
      if (error instanceof TeamError)
        return { status: ERROR_STATUS[error.code], body: { code: error.code, message: error.message } };
      if (error instanceof StaffError && error.code === 'FORBIDDEN')
        return { status: 403, body: { code: error.code, message: error.message } };
      if (error instanceof URIError) return { status: 400, body: { code: 'INVALID_INPUT' } };
      throw error;
    }
  };
}
