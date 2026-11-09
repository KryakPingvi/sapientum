CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at AND idle_expires_at <= expires_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id, created_at, id);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  digest TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_session ON auth_refresh_tokens (session_id);
