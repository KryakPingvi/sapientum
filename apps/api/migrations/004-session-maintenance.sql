CREATE INDEX IF NOT EXISTS auth_sessions_owner_cursor ON auth_sessions (user_id, id);
CREATE INDEX IF NOT EXISTS auth_sessions_revoked ON auth_sessions (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_deadline ON auth_sessions (LEAST(expires_at, idle_expires_at));
