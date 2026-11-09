import type { SessionPrincipal } from '@sapientum/contracts/sessions';
import type { SessionRecord } from '../domain/session.js';

export interface AccountCredentials {
  /** Verify credentials of a pre-created account. Must not create accounts. */
  verify(login: string, password: string): Promise<string | null>;
}

export interface SessionAccounts {
  isEnabled(userId: string): Promise<boolean>;
}

export interface RefreshRecord {
  digest: string;
  sessionId: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SessionRepository {
  lockUser(userId: string): Promise<void>;
  insert(session: SessionRecord): Promise<void>;
  /** Holds the session row lock until transaction completion. */
  find(id: string, userId: string): Promise<SessionRecord | null>;
  list(userId: string): Promise<readonly SessionRecord[]>;
  touch(session: SessionRecord): Promise<void>;
  revoke(id: string, at: string): Promise<void>;
  revokeAll(userId: string, at: string): Promise<void>;
  insertRefresh(token: RefreshRecord): Promise<void>;
  /** Locks the parent session BEFORE reading token state, to serialize refresh/logout. */
  findRefresh(digest: string): Promise<{ session: SessionRecord; token: RefreshRecord } | null>;
  consumeRefresh(digest: string, at: string): Promise<void>;
}

export interface SessionTransaction {
  run<T>(operation: (context: { sessions: SessionRepository; accounts: SessionAccounts }) => Promise<T>): Promise<T>;
}

export interface AccessTokens {
  issue(principal: SessionPrincipal, now: Date, expiresAt: Date): Promise<string>;
  verify(token: string, now: Date): Promise<SessionPrincipal>;
}

export interface SessionRuntime {
  now(): Date;
  newId(): string;
  newRefreshToken(): string;
  digest(token: string): string;
}
