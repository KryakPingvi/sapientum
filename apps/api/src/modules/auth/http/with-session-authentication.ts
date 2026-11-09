import type { SessionService } from '../application/session-service.js';
import { SessionError } from '../domain/session.js';

interface Request {
  method: string;
  url: string;
  body?: unknown;
  principal: { userId: string } | null;
}

interface Response {
  status: number;
  body: unknown;
}

/** Wraps domain HTTP adapters. Anonymous requests still reach public routes. */
export function withSessionAuthentication(service: SessionService, handler: (request: Request) => Promise<Response>) {
  return async (request: Omit<Request, 'principal'> & { accessToken: string }): Promise<Response> => {
    let principal = null;
    try {
      principal = request.accessToken ? await service.authenticate(request.accessToken) : null;
    } catch (error) {
      if (error instanceof SessionError && error.code === 'UNAUTHENTICATED')
        return { status: 401, body: { code: error.code } };
      throw error;
    }
    return handler({ ...request, principal });
  };
}
