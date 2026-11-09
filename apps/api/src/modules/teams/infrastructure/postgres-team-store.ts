import type { TeamFilter, TeamStatus } from '@sapientum/contracts/teams';
import type { PostgresDatabase, SqlClient } from '../../../infrastructure/postgres.js';
import { requirePostgresStaffPermission } from '../../staff/index.js';
import type {
  TeamAccountDirectory,
  TeamContext,
  TeamRepository,
  TeamTransaction,
  TournamentDirectory,
} from '../application/ports.js';
import { Team } from '../domain/team.js';
import { TeamError } from '../domain/team-error.js';

interface TeamRow {
  id: string;
  tournament_id: string;
  leader_id: string;
  name: string;
  organization: string;
  leader_name: string;
  status: TeamStatus;
  submitted_at: Date;
  confirmed_at: Date | null;
  confirmed_by: string | null;
}

function restore(row: TeamRow): Team {
  return Team.restore({
    id: row.id,
    tournamentId: row.tournament_id,
    leaderId: row.leader_id,
    name: row.name,
    organization: row.organization,
    leaderName: row.leader_name,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmedBy: row.confirmed_by,
  });
}

class PostgresTeamRepository implements TeamRepository {
  constructor(private readonly sql: SqlClient) {}

  async insert(team: Team): Promise<void> {
    const s = team.snapshot();
    try {
      await this.sql.query(
        `INSERT INTO teams (id, tournament_id, leader_id, name, organization, leader_name, status, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.id, s.tournamentId, s.leaderId, s.name, s.organization, s.leaderName, s.status, s.submittedAt],
      );
    } catch (error) {
      if (
        (error as { code?: string }).code === '23505' &&
        (error as { constraint?: string }).constraint === 'teams_tournament_name'
      ) {
        throw new TeamError('DUPLICATE_NAME', 'Team name is already taken in this tournament.');
      }
      throw error;
    }
  }

  async findById(tournamentId: string, teamId: string): Promise<Team | null> {
    const { rows } = await this.sql.query<TeamRow>('SELECT * FROM teams WHERE tournament_id = $1 AND id = $2', [
      tournamentId,
      teamId,
    ]);
    return rows[0] ? restore(rows[0]) : null;
  }

  async confirm(team: Team): Promise<void> {
    const s = team.snapshot();
    const result = await this.sql.query(
      `UPDATE teams SET status = 'confirmed', confirmed_at = $1, confirmed_by = $2
       WHERE tournament_id = $3 AND id = $4 AND status = 'pending'`,
      [s.confirmedAt, s.confirmedBy, s.tournamentId, s.id],
    );
    if (result.rowCount !== 1) throw new TeamError('ALREADY_CONFIRMED', 'Team is no longer pending.');
  }

  async list(tournamentId: string, status: TeamFilter): Promise<readonly Team[]> {
    const { rows } = await this.sql.query<TeamRow>(
      `SELECT * FROM teams WHERE tournament_id = $1 AND ($2 = 'all' OR status = $2) ORDER BY submitted_at, id`,
      [tournamentId, status],
    );
    return rows.map(restore);
  }
}

/** Bind future account/tournament adapters to this SQL client to keep their checks in the same transaction. */
export type TeamDependencyFactory = (sql: SqlClient) => {
  accounts: TeamAccountDirectory;
  tournaments: TournamentDirectory;
};

export class PostgresTeamStore implements TeamTransaction {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly dependencies: TeamDependencyFactory,
  ) {}

  run<T>(operation: (context: TeamContext) => Promise<T>): Promise<T> {
    return this.database.transaction((sql) =>
      operation({
        teams: new PostgresTeamRepository(sql),
        ...this.dependencies(sql),
        requireOrganizer: (tournamentId, actorId) =>
          requirePostgresStaffPermission(sql, tournamentId, actorId, 'tournament.manage'),
      }),
    );
  }
}
