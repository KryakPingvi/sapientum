import type { PostgresDatabase, SqlClient } from '../../../infrastructure/postgres.js';
import type { SessionRecord } from '../domain/session.js';
import type { SessionRepository, SessionTransaction, SessionAccounts, RefreshRecord } from '../application/ports.js';

interface SessionRow {
  id: string;
  user_id: string;
  device_label: string;
  user_agent: string;
  ip: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  idle_expires_at: Date;
  revoked_at: Date | null;
}

function restore(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    idleExpiresAt: row.idle_expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly sql: SqlClient) {}

  async lockUser(userId: string): Promise<void> {
    await this.sql.query("SELECT pg_advisory_xact_lock(hashtext('auth'), hashtext($1))", [userId]);
  }

  async insert(s: SessionRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO auth_sessions
      (id, user_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at, idle_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id, s.userId, s.deviceLabel, s.userAgent, s.ip, s.createdAt, s.lastSeenAt, s.expiresAt, s.idleExpiresAt],
    );
  }

  async find(id: string, userId: string): Promise<SessionRecord | null> {
    const { rows } = await this.sql.query<SessionRow>(
      'SELECT * FROM auth_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, userId],
    );
    return rows[0] ? restore(rows[0]) : null;
  }

  async list(userId: string): Promise<readonly SessionRecord[]> {
    const { rows } = await this.sql.query<SessionRow>(
      'SELECT * FROM auth_sessions WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return rows.map(restore);
  }

  async touch(s: SessionRecord): Promise<void> {
    await this.sql.query('UPDATE auth_sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [
      s.id,
      s.lastSeenAt,
      s.idleExpiresAt,
    ]);
  }

  async revoke(id: string, at: string): Promise<void> {
    await this.sql.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [id, at]);
  }

  async revokeAll(userId: string, at: string): Promise<void> {
    await this.sql.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1', [
      userId,
      at,
    ]);
  }

  async insertRefresh(token: RefreshRecord): Promise<void> {
    await this.sql.query('INSERT INTO auth_refresh_tokens (digest, session_id, expires_at) VALUES ($1,$2,$3)', [
      token.digest,
      token.sessionId,
      token.expiresAt,
    ]);
  }

  async findRefresh(digest: string): Promise<{ session: SessionRecord; token: RefreshRecord } | null> {
    const { rows } = await this.sql.query<{ session_id: string; user_id: string }>(
      'SELECT t.session_id, s.user_id FROM auth_refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id WHERE t.digest = $1',
      [digest],
    );
    if (!rows[0]) return null;
    // Read token state AFTER the parent lock; a concurrent rotation may have consumed it while we waited.
    const session = (await this.find(rows[0].session_id, rows[0].user_id))!;
    const result = await this.sql.query<{ expires_at: Date; used_at: Date | null }>(
      'SELECT expires_at, used_at FROM auth_refresh_tokens WHERE digest = $1',
      [digest],
    );
    const token = result.rows[0]!;
    return {
      session,
      token: {
        digest,
        sessionId: session.id,
        expiresAt: token.expires_at.toISOString(),
        usedAt: token.used_at?.toISOString() ?? null,
      },
    };
  }

  async consumeRefresh(digest: string, at: string): Promise<void> {
    await this.sql.query('UPDATE auth_refresh_tokens SET used_at = $2 WHERE digest = $1', [digest, at]);
  }
}

export class PostgresSessionStore implements SessionTransaction {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly accounts: (sql: SqlClient) => SessionAccounts,
  ) {}

  run<T>(operation: (context: { sessions: SessionRepository; accounts: SessionAccounts }) => Promise<T>): Promise<T> {
    return this.database.transaction((sql) =>
      operation({ sessions: new PostgresSessionRepository(sql), accounts: this.accounts(sql) }),
    );
  }
}
