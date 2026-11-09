export const SESSION_STATES = ['active', 'expired', 'revoked'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface SessionDto {
  readonly id: string;
  readonly deviceLabel: string;
  readonly userAgent: string;
  readonly ip: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly revokedAt: string | null;
  readonly state: SessionState;
  readonly current: boolean;
}

export interface SessionPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AccessGrant {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly sessionId: string;
}
