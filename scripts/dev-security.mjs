import { scrypt } from 'node:crypto';

export const passwordDigest = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (error, value) => (error ? reject(error) : resolve(value)));
  });

export function loginGuard(database) {
  let inFlight = 0;
  return async function guarded(input, operation) {
    if (inFlight >= 4) return { status: 429, body: { code: 'LOGIN_BUSY' }, headers: { 'Cache-Control': 'no-store' } };
    inFlight++;
    try {
      const login = typeof input.body?.login === 'string' ? input.body.login.trim().slice(0, 200) : '';
      const ip = String(input.ip).slice(0, 128);
      const allowed = await database.transaction(async (sql) => {
        // PostgreSQL windows are shared by identity replicas. No waiting for another pool connection inside this transaction.
        for (const [key, limit] of [
          [JSON.stringify(['ip', ip]), 100],
          [JSON.stringify(['account-ip', ip, login]), 10],
        ]) {
          const { rows } = await sql.query(
            `INSERT INTO demo_login_windows(key,started_at,hits) VALUES($1,clock_timestamp(),1)
            ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN demo_login_windows.started_at < clock_timestamp()-interval '1 minute' THEN 1 ELSE demo_login_windows.hits+1 END,
            started_at=CASE WHEN demo_login_windows.started_at < clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE demo_login_windows.started_at END RETURNING hits`,
            [key],
          );
          if (rows[0].hits > limit) return false;
        }
        await sql.query("DELETE FROM demo_login_windows WHERE started_at < clock_timestamp()-interval '2 minutes'");
        return true;
      });
      if (!allowed) return { status: 429, body: { code: 'LOGIN_THROTTLED' }, headers: { 'Cache-Control': 'no-store' } };
      return await operation();
    } finally {
      inFlight--;
    }
  };
}

/** Counts original bytes and decodes once; every UTF-8 split boundary is preserved. */
export async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw Object.assign(new Error('Body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw Object.assign(new Error('Invalid JSON/UTF-8'), { code: 'INVALID_JSON' });
  }
}
