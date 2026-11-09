export class SessionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface SessionPolicy {
  accessSeconds: number;
  idleSeconds: number;
  absoluteSeconds: number;
}

export const DEFAULT_SESSION_POLICY: Readonly<SessionPolicy> = Object.freeze({
  accessSeconds: 15 * 60,
  idleSeconds: 7 * 24 * 60 * 60,
  absoluteSeconds: 30 * 24 * 60 * 60,
});

export function sessionPolicy(input: SessionPolicy): Readonly<SessionPolicy> {
  if (
    !Object.values(input).every((value) => Number.isSafeInteger(value) && value > 0) ||
    input.accessSeconds > 3600 ||
    input.idleSeconds < input.accessSeconds ||
    input.absoluteSeconds < input.idleSeconds ||
    input.absoluteSeconds > 366 * 86400
  ) {
    throw new SessionError('INVALID_INPUT', 'Invalid session lifetimes.');
  }
  return Object.freeze({ ...input });
}

export function sessionText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionError('INVALID_INPUT', 'Invalid session input.');
  }
  return value.trim();
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceLabel: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  idleExpiresAt: string;
  revokedAt: string | null;
}

export function active(session: SessionRecord, now: Date): boolean {
  return (
    session.revokedAt === null &&
    Date.parse(session.expiresAt) > now.getTime() &&
    Date.parse(session.idleExpiresAt) > now.getTime()
  );
}
