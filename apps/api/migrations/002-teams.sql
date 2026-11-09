CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200 AND name = btrim(name)),
  organization TEXT NOT NULL CHECK (length(btrim(organization)) BETWEEN 1 AND 300),
  leader_name TEXT NOT NULL CHECK (length(btrim(leader_name)) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  submitted_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  confirmed_by TEXT,
  CHECK ((status = 'pending' AND confirmed_at IS NULL AND confirmed_by IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_tournament_name ON teams (tournament_id, lower(name));
CREATE INDEX IF NOT EXISTS teams_tournament_status ON teams (tournament_id, status, submitted_at, id);
