import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors } from 'jose';
import type { SessionPrincipal } from '@sapientum/contracts/sessions';
import type { AccessTokens, SessionRuntime } from '../application/ports.js';
import { SessionError } from '../domain/session.js';

export const secureSessionRuntime: SessionRuntime = {
  now: () => new Date(),
  newId: randomUUID,
  newRefreshToken: () => randomBytes(32).toString('base64url'),
  digest: (token) => createHash('sha256').update(token).digest('hex'),
};

export class JoseAccessTokens implements AccessTokens {
  private readonly key: Uint8Array;

  constructor(
    key: Uint8Array,
    private readonly issuer: string,
    private readonly audience: string,
  ) {
    if (key.length < 32 || !issuer.trim() || !audience.trim())
      throw new SessionError(
        'INVALID_INPUT',
        'JWT key must have at least 32 random bytes; issuer and audience are required.',
      );
    this.key = new Uint8Array(key);
  }

  issue(principal: SessionPrincipal, now: Date, expiresAt: Date): Promise<string> {
    return new SignJWT({ sid: principal.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject(principal.userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
  }

  async verify(token: string, now: Date): Promise<SessionPrincipal> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        typ: 'at+jwt',
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: ['sub', 'sid', 'iat', 'exp', 'jti'],
        currentDate: now,
      });
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        typeof payload.sid !== 'string' ||
        !payload.sid ||
        typeof payload.iat !== 'number' ||
        payload.iat > now.getTime() / 1000 ||
        typeof payload.jti !== 'string' ||
        !payload.jti
      ) {
        throw new SessionError('UNAUTHENTICATED', 'Invalid access token claims.');
      }
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (error) {
      if (error instanceof errors.JOSEError)
        throw new SessionError('UNAUTHENTICATED', 'Invalid or expired access token.');
      throw error;
    }
  }
}
