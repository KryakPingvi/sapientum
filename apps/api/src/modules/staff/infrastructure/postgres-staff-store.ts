import type { StaffRole, StaffStatus } from '@sapientum/contracts/staff';
import type { PostgresDatabase, SqlClient } from '../../../infrastructure/postgres.js';
import { StaffMember } from '../domain/staff-member.js';
import { StaffError } from '../domain/staff-error.js';
import type { StaffAuditEntry, StaffAuditWriter, StaffRepository, StaffTransaction } from '../application/ports.js';

interface MemberRow {
  id: string;
  tournament_id: string;
  user_id: string;
  status: StaffStatus;
  roles: StaffRole[];
  added_at: Date;
  added_by: string;
  excluded_at: Date | null;
  excluded_by: string | null;
  version: number;
}

function restore(row: MemberRow): StaffMember {
  return StaffMember.restore({
    id: row.id,
    tournamentId: row.tournament_id,
    userId: row.user_id,
    status: row.status,
    roles: row.roles,
    addedAt: row.added_at.toISOString(),
    addedBy: row.added_by,
    excludedAt: row.excluded_at?.toISOString() ?? null,
    excludedBy: row.excluded_by,
    version: row.version,
  });
}

class PostgresStaffRepository implements StaffRepository {
  constructor(private readonly sql: SqlClient) {}

  async lockTournament(tournamentId: string): Promise<void> {
    await this.sql.query("SELECT pg_advisory_xact_lock(hashtext('staff'), hashtext($1))", [tournamentId]);
  }

  findByUser(tournamentId: string, userId: string): Promise<StaffMember | null> {
    return this.one('SELECT * FROM staff_members WHERE tournament_id = $1 AND user_id = $2', [tournamentId, userId]);
  }

  findById(tournamentId: string, memberId: string): Promise<StaffMember | null> {
    return this.one('SELECT * FROM staff_members WHERE tournament_id = $1 AND id = $2', [tournamentId, memberId]);
  }

  async list(tournamentId: string, status: StaffStatus): Promise<readonly StaffMember[]> {
    const { rows } = await this.sql.query<MemberRow>(
      'SELECT * FROM staff_members WHERE tournament_id = $1 AND status = $2 ORDER BY added_at, id',
      [tournamentId, status],
    );
    return rows.map(restore);
  }

  countAdministrators(tournamentId: string): Promise<number> {
    return this.count(
      "SELECT COUNT(*) FROM staff_members WHERE tournament_id = $1 AND status = 'active' AND 'administrator' = ANY(roles)",
      [tournamentId],
    );
  }

  countMembers(tournamentId: string): Promise<number> {
    return this.count('SELECT COUNT(*) FROM staff_members WHERE tournament_id = $1', [tournamentId]);
  }

  async insert(member: StaffMember): Promise<void> {
    const s = member.snapshot();
    await this.sql.query(
      `INSERT INTO staff_members
        (id, tournament_id, user_id, status, roles, added_at, added_by, excluded_at, excluded_by, version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [s.id, s.tournamentId, s.userId, s.status, s.roles, s.addedAt, s.addedBy, s.excludedAt, s.excludedBy, s.version],
    );
  }

  async update(member: StaffMember, expectedVersion: number): Promise<void> {
    const s = member.snapshot();
    const result = await this.sql.query(
      `UPDATE staff_members SET roles = $1, status = $2, excluded_at = $3, excluded_by = $4, version = $5
        WHERE id = $6 AND tournament_id = $7 AND version = $8`,
      [s.roles, s.status, s.excludedAt, s.excludedBy, s.version, s.id, s.tournamentId, expectedVersion],
    );
    if (result.rowCount !== 1) throw new StaffError('VERSION_CONFLICT', 'Membership has changed.');
  }

  private async one(text: string, values: unknown[]): Promise<StaffMember | null> {
    const { rows } = await this.sql.query<MemberRow>(text, values);
    return rows[0] ? restore(rows[0]) : null;
  }

  private async count(text: string, values: unknown[]): Promise<number> {
    const { rows } = await this.sql.query<{ count: string }>(text, values);
    return Number(rows[0]?.count);
  }
}

class PostgresStaffAudit implements StaffAuditWriter {
  constructor(private readonly sql: SqlClient) {}

  async append(entry: StaffAuditEntry): Promise<void> {
    await this.sql.query(
      `INSERT INTO staff_audit
        (id, tournament_id, member_id, actor_id, action, at, before_snapshot, after_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.id, entry.tournamentId, entry.memberId, entry.actorId, entry.action, entry.at, entry.before, entry.after],
    );
  }
}

export class PostgresStaffStore implements StaffTransaction {
  constructor(private readonly database: PostgresDatabase) {}

  run<T>(operation: (context: { members: StaffRepository; audit: StaffAuditWriter }) => Promise<T>): Promise<T> {
    return this.database.transaction((sql) =>
      operation({ members: new PostgresStaffRepository(sql), audit: new PostgresStaffAudit(sql) }),
    );
  }
}
