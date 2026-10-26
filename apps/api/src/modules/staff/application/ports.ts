import type { StaffMemberDto, StaffStatus } from '@sapientum/contracts/staff';
import type { StaffMember } from '../domain/staff-member.js';

export interface StaffReader {
  findByUser(tournamentId: string, userId: string): Promise<StaffMember | null>;
}

export interface StaffRepository extends StaffReader {
  lockTournament(tournamentId: string): Promise<void>;
  findById(tournamentId: string, memberId: string): Promise<StaffMember | null>;
  list(tournamentId: string, status: StaffStatus): Promise<readonly StaffMember[]>;
  countAdministrators(tournamentId: string): Promise<number>;
  countMembers(tournamentId: string): Promise<number>;
  insert(member: StaffMember): Promise<void>;
  update(member: StaffMember, expectedVersion: number): Promise<void>;
}

export interface StaffAuditEntry {
  id: string;
  action: 'first-administrator-appointed' | 'member-added' | 'roles-assigned' | 'member-excluded';
  tournamentId: string;
  memberId: string;
  actorId: string;
  at: string;
  before: StaffMemberDto | null;
  after: StaffMemberDto;
}

export interface StaffAuditWriter {
  append(entry: StaffAuditEntry): Promise<void>;
}

export interface StaffTransaction {
  run<T>(operation: (context: { members: StaffRepository; audit: StaffAuditWriter }) => Promise<T>): Promise<T>;
}

export interface AccountDirectory {
  exists(userId: string): Promise<boolean>;
}

export interface StaffRuntime {
  newId(): string;
  now(): string;
}
