import { DatabaseSync } from 'node:sqlite';
import type { StaffMemberDto, StaffStatus } from '@sapientum/contracts/staff';
import { StaffMember } from '../domain/staff-member.js';
import { StaffError } from '../domain/staff-error.js';
import type { StaffAuditEntry, StaffAuditWriter, StaffRepository, StaffTransaction } from '../application/ports.js';

type Row = Record<string, unknown>;

function restore(row: Row): StaffMember {
  return StaffMember.restore({
    id: String(row.id),
    tournamentId: String(row.tournament_id),
    userId: String(row.user_id),
    status: row.status as StaffStatus,
    roles: JSON.parse(String(row.roles)) as StaffMemberDto['roles'],
    addedAt: String(row.added_at),
    addedBy: String(row.added_by),
    excludedAt: row.excluded_at === null ? null : String(row.excluded_at),
    excludedBy: row.excluded_by === null ? null : String(row.excluded_by),
    version: Number(row.version),
  });
}

class SqliteStaffRepository implements StaffRepository {
  constructor(private readonly db: DatabaseSync) {}
  findByUser(tournamentId: string, userId: string): StaffMember | null {
    const row = this.db
      .prepare('SELECT * FROM staff_members WHERE tournament_id = ? AND user_id = ?')
      .get(tournamentId, userId);
    return row ? restore(row) : null;
  }
  findById(tournamentId: string, memberId: string): StaffMember | null {
    const row = this.db
      .prepare('SELECT * FROM staff_members WHERE tournament_id = ? AND id = ?')
      .get(tournamentId, memberId);
    return row ? restore(row) : null;
  }
  list(tournamentId: string, status: StaffStatus): readonly StaffMember[] {
    return this.db
      .prepare('SELECT * FROM staff_members WHERE tournament_id = ? AND status = ? ORDER BY added_at, id')
      .all(tournamentId, status)
      .map(restore);
  }
  countAdministrators(tournamentId: string): number {
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM staff_members
      WHERE tournament_id = ? AND status = 'active'
      AND EXISTS (SELECT 1 FROM json_each(staff_members.roles) WHERE value = 'administrator')`,
        )
        .get(tournamentId)?.count,
    );
  }
  countMembers(tournamentId: string): number {
    return Number(
      this.db.prepare('SELECT COUNT(*) AS count FROM staff_members WHERE tournament_id = ?').get(tournamentId)?.count,
    );
  }
  insert(member: StaffMember): void {
    const s = member.snapshot();
    this.db
      .prepare(
        `INSERT INTO staff_members
      (id, tournament_id, user_id, status, roles, added_at, added_by, excluded_at, excluded_by, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.tournamentId,
        s.userId,
        s.status,
        JSON.stringify(s.roles),
        s.addedAt,
        s.addedBy,
        s.excludedAt,
        s.excludedBy,
        s.version,
      );
  }
  update(member: StaffMember, expectedVersion: number): void {
    const s = member.snapshot();
    const result = this.db
      .prepare(
        `UPDATE staff_members SET roles = ?, status = ?, excluded_at = ?,
      excluded_by = ?, version = ? WHERE id = ? AND tournament_id = ? AND version = ?`,
      )
      .run(
        JSON.stringify(s.roles),
        s.status,
        s.excludedAt,
        s.excludedBy,
        s.version,
        s.id,
        s.tournamentId,
        expectedVersion,
      );
    if (result.changes !== 1) throw new StaffError('VERSION_CONFLICT', 'Membership has changed.');
  }
}

class SqliteStaffAudit implements StaffAuditWriter {
  constructor(private readonly db: DatabaseSync) {}
  append(entry: StaffAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO staff_audit
      (id, tournament_id, member_id, actor_id, action, at, before_snapshot, after_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tournamentId,
        entry.memberId,
        entry.actorId,
        entry.action,
        entry.at,
        entry.before === null ? null : JSON.stringify(entry.before),
        JSON.stringify(entry.after),
      );
  }
}

/** Owns a dedicated connection. BEGIN IMMEDIATE serializes writers before authorization and admin-count checks. */
export class SqliteStaffStore implements StaffTransaction {
  private readonly db: DatabaseSync;
  private running = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  }

  migrate(sql: string): void {
    this.db.exec(sql);
  }

  run<T>(operation: (context: { members: StaffRepository; audit: StaffAuditWriter }) => T): T {
    if (this.running) throw new Error('Nested staff transactions are not supported.');
    this.db.exec('BEGIN IMMEDIATE');
    this.running = true;
    try {
      const result = operation({ members: new SqliteStaffRepository(this.db), audit: new SqliteStaffAudit(this.db) });
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('Staff transaction callbacks must be synchronous.');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.running = false;
    }
  }

  close(): void {
    this.db.close();
  }
}
