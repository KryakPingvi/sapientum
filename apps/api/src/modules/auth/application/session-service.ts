import type { AccessGrant, SessionDto, SessionPrincipal } from '@sapientum/contracts/sessions';
import { SESSION_STATES } from '@sapientum/contracts/sessions';
import {
  active,
  DEFAULT_SESSION_POLICY,
  SessionError,
  sessionPolicy,
  sessionText,
  type SessionPolicy,
  type SessionRecord,
} from '../domain/session.js';
import type {
  AccountCredentials,
  AccessTokens,
  SessionRepository,
  SessionRuntime,
  SessionTransaction,
  SessionAccounts,
} from './ports.js';

export interface SessionGrant extends AccessGrant {
  /** Secret; HTTP host writes it to a Secure HttpOnly cookie, never JSON/logs. */
  refreshToken: string;
  refreshExpiresAt: string;
}

export class SessionService {
  private readonly policy: Readonly<SessionPolicy>;

  constructor(
    private readonly transactions: SessionTransaction,
    private readonly credentials: AccountCredentials,
    private readonly tokens: AccessTokens,
    private readonly runtime: SessionRuntime,
    policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {
    this.policy = sessionPolicy(policy);
  }

  async login(input: {
    login: unknown;
    password: unknown;
    deviceLabel: unknown;
    userAgent: unknown;
    ip: unknown;
  }): Promise<SessionGrant> {
    const login = sessionText(input.login, 200);
    // Password bytes are preserved, including whitespace; no normalization.
    if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > 1024) {
      throw new SessionError('INVALID_INPUT', 'Invalid credentials input.');
    }
    const deviceLabel = sessionText(input.deviceLabel, 120);
    const userAgent = sessionText(input.userAgent, 512);
    const ip = sessionText(input.ip, 128);
    const userId = await this.credentials.verify(login, input.password);
    if (!userId) throw this.denied();
    return this.transactions.run(async ({ sessions, accounts }) => {
      await sessions.lockUser(userId);
      if (!(await accounts.isEnabled(userId))) throw this.denied();
      const now = this.runtime.now();
      const session: SessionRecord = {
        id: this.runtime.newId(),
        userId,
        deviceLabel,
        userAgent,
        ip,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: this.after(now, this.policy.absoluteSeconds),
        idleExpiresAt: this.after(now, this.policy.idleSeconds),
        revokedAt: null,
      };
      await sessions.insert(session);
      return this.grant(sessions, session, now);
    });
  }

  async authenticate(accessToken: string): Promise<SessionPrincipal> {
    const now = this.runtime.now();
    const principal = await this.tokens.verify(accessToken, now);
    return this.transactions.run(async ({ sessions, accounts }) => {
      await this.authorized(sessions, accounts, principal);
      return principal;
    });
  }

  async refresh(refreshToken: unknown): Promise<SessionGrant> {
    if (typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw this.denied();
    const digest = this.runtime.digest(refreshToken);
    // Reuse revocation must COMMIT before the error is returned to the caller.
    const grant = await this.transactions.run(async ({ sessions, accounts }) => {
      const found = await sessions.findRefresh(digest);
      if (!found) return null;
      const now = this.runtime.now();
      const { session, token } = found;
      if (token.usedAt !== null) {
        await sessions.revoke(session.id, now.toISOString());
        return null;
      }
      if (
        !active(session, now) ||
        Date.parse(token.expiresAt) <= now.getTime() ||
        !(await accounts.isEnabled(session.userId))
      )
        return null;
      await sessions.consumeRefresh(digest, now.toISOString());
      return this.grant(sessions, session, now);
    });
    if (!grant) throw this.denied();
    return grant;
  }

  async list(accessToken: string): Promise<readonly SessionDto[]> {
    const now = this.runtime.now();
    const principal = await this.tokens.verify(accessToken, now);
    return this.transactions.run(async ({ sessions, accounts }) => {
      const checkedAt = await this.authorized(sessions, accounts, principal);
      return (await sessions.list(principal.userId)).map((session) => ({
        id: session.id,
        deviceLabel: session.deviceLabel,
        userAgent: session.userAgent,
        ip: session.ip,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        idleExpiresAt: session.idleExpiresAt,
        revokedAt: session.revokedAt,
        state:
          session.revokedAt !== null
            ? SESSION_STATES[2]
            : active(session, checkedAt)
              ? SESSION_STATES[0]
              : SESSION_STATES[1],
        current: session.id === principal.sessionId,
      }));
    });
  }

  /** null means all own sessions, including the current one. Never accepts a caller-supplied user ID. */
  async revoke(accessToken: string, sessionId: string | null): Promise<boolean> {
    const principal = await this.tokens.verify(accessToken, this.runtime.now());
    if (sessionId !== null) sessionText(sessionId, 200);
    return this.transactions.run(async ({ sessions, accounts }) => {
      // Consistent user -> session lock order avoids deadlocks for two devices revoking each other.
      await sessions.lockUser(principal.userId);
      const now = await this.authorized(sessions, accounts, principal);
      if (sessionId === null) {
        await sessions.revokeAll(principal.userId, now.toISOString());
        return true;
      }
      const target = await sessions.find(sessionId, principal.userId);
      if (!target) throw new SessionError('NOT_FOUND', 'Session not found.');
      await sessions.revoke(sessionId, now.toISOString());
      return sessionId === principal.sessionId;
    });
  }

  private async authorized(sessions: SessionRepository, accounts: SessionAccounts, principal: SessionPrincipal) {
    const session = await sessions.find(principal.sessionId, principal.userId);
    const now = this.runtime.now();
    if (!session || !active(session, now) || !(await accounts.isEnabled(principal.userId))) throw this.denied();
    session.lastSeenAt = now.toISOString();
    session.idleExpiresAt = this.after(now, this.policy.idleSeconds, session.expiresAt);
    await sessions.touch(session);
    return now;
  }

  private async grant(sessions: SessionRepository, session: SessionRecord, now: Date): Promise<SessionGrant> {
    const refreshToken = this.runtime.newRefreshToken();
    session.lastSeenAt = now.toISOString();
    session.idleExpiresAt = this.after(now, this.policy.idleSeconds, session.expiresAt);
    const expiresAt = this.after(now, this.policy.accessSeconds, session.expiresAt);
    const accessToken = await this.tokens.issue(
      { userId: session.userId, sessionId: session.id },
      now,
      new Date(expiresAt),
    );
    await sessions.insertRefresh({
      digest: this.runtime.digest(refreshToken),
      sessionId: session.id,
      expiresAt: session.idleExpiresAt,
      usedAt: null,
    });
    await sessions.touch(session);
    return { accessToken, refreshToken, sessionId: session.id, expiresAt, refreshExpiresAt: session.idleExpiresAt };
  }

  private after(now: Date, seconds: number, limit = '9999-12-31T23:59:59.000Z'): string {
    return new Date(Math.min(now.getTime() + seconds * 1000, Date.parse(limit))).toISOString();
  }

  private denied() {
    return new SessionError('UNAUTHENTICATED', 'Invalid credentials or inactive session.');
  }
}
