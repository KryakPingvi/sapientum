CREATE TABLE IF NOT EXISTS staff_members (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'excluded')),
  roles TEXT[] NOT NULL CHECK (roles <@ ARRAY['jury', 'representative', 'author', 'administrator', 'organizer']),
  added_at TIMESTAMPTZ NOT NULL,
  added_by TEXT NOT NULL,
  excluded_at TIMESTAMPTZ,
  excluded_by TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  UNIQUE (tournament_id, user_id),
  CHECK ((status = 'active' AND excluded_at IS NULL AND excluded_by IS NULL)
    OR (status = 'excluded' AND excluded_at IS NOT NULL AND excluded_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS staff_members_status ON staff_members (tournament_id, status);

CREATE TABLE IF NOT EXISTS staff_audit (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES staff_members (id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  before_snapshot JSONB,
  after_snapshot JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS staff_audit_tournament ON staff_audit (tournament_id, at);
