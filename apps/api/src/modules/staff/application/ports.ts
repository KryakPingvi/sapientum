import type { StaffMemberDto, StaffStatus } from '@sapientum/contracts/staff';
import type { StaffMember } from '../domain/staff-member.js';

export interface StaffReader {
  findByUser(tournamentId: string, userId: string): StaffMember | null;
}

export interface StaffRepository extends StaffReader {
  findById(tournamentId: string, memberId: string): StaffMember | null;
  list(tournamentId: string, status: StaffStatus): readonly StaffMember[];
  countAdministrators(tournamentId: string): number;
  countMembers(tournamentId: string): number;
  insert(member: StaffMember): void;
  update(member: StaffMember, expectedVersion: number): void;
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

export interface StaffAuditWriter { append(entry: StaffAuditEntry): void; }

export interface StaffTransaction {
  /** Repository operations and audit append commit together; callback must be synchronous. */
  run<T>(operation: (context: { members: StaffRepository; audit: StaffAuditWriter }) => T): T;
}

/** Adapter to the account module; account creation is a separate operation. */
export interface AccountDirectory { exists(userId: string): boolean; }
export interface StaffRuntime { newId(): string; now(): string; }
