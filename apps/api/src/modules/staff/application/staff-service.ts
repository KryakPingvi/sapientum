import type { StaffMemberDto, StaffStatus } from '@sapientum/contracts/staff';
import { StaffError } from '../domain/staff-error.js';
import { StaffMember, requireId } from '../domain/staff-member.js';
import { StaffAccess } from './staff-access.js';
import type {
  AccountDirectory,
  StaffAuditEntry,
  StaffAuditWriter,
  StaffRepository,
  StaffRuntime,
  StaffTransaction,
} from './ports.js';

export class StaffService {
  constructor(
    private readonly transactions: StaffTransaction,
    private readonly accounts: AccountDirectory,
    private readonly runtime: StaffRuntime,
  ) {}

  add(input: { actorId: string; tournamentId: string; userId: string; roles: unknown }): StaffMemberDto {
    return this.transactions.run(({ members, audit }) => {
      new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      requireId(input.userId);
      if (!this.accounts.exists(input.userId)) throw new StaffError('USER_NOT_FOUND', 'Account does not exist.');
      if (members.findByUser(input.tournamentId, input.userId)) {
        throw new StaffError('DUPLICATE_MEMBER', 'This account already has a membership, possibly excluded.');
      }
      const member = StaffMember.add({ ...input, id: this.runtime.newId(), at: this.runtime.now() });
      members.insert(member);
      this.record(audit, 'member-added', input.actorId, null, member);
      return member.snapshot();
    });
  }

  setRoles(input: {
    actorId: string;
    tournamentId: string;
    memberId: string;
    roles: unknown;
    expectedVersion: number;
  }): StaffMemberDto {
    return this.transactions.run(({ members, audit }) => {
      new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      const before = this.get(members, input.tournamentId, input.memberId);
      const after = before.setRoles(input.roles, input.expectedVersion);
      this.protectAdministrator(members, before, after);
      members.update(after, input.expectedVersion);
      this.record(audit, 'roles-assigned', input.actorId, before, after);
      return after.snapshot();
    });
  }

  exclude(input: { actorId: string; tournamentId: string; memberId: string; expectedVersion: number }): StaffMemberDto {
    return this.transactions.run(({ members, audit }) => {
      new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      const before = this.get(members, input.tournamentId, input.memberId);
      const after = before.exclude(input.actorId, this.runtime.now(), input.expectedVersion);
      this.protectAdministrator(members, before, after);
      members.update(after, input.expectedVersion);
      this.record(audit, 'member-excluded', input.actorId, before, after);
      return after.snapshot();
    });
  }

  list(input: { actorId: string; tournamentId: string; status: StaffStatus }): readonly StaffMemberDto[] {
    return this.transactions.run(({ members }) => {
      new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      if (input.status !== 'active' && input.status !== 'excluded') {
        throw new StaffError('INVALID_INPUT', 'Unknown membership status.');
      }
      return members.list(input.tournamentId, input.status).map((member) => member.snapshot());
    });
  }

  private get(members: StaffRepository, tournamentId: string, memberId: string): StaffMember {
    requireId(memberId);
    const member = members.findById(tournamentId, memberId);
    if (!member) throw new StaffError('NOT_FOUND', 'Membership does not exist in this tournament.');
    return member;
  }

  private protectAdministrator(members: StaffRepository, before: StaffMember, after: StaffMember): void {
    if (
      before.hasRole('administrator') &&
      !after.hasRole('administrator') &&
      members.countAdministrators(before.snapshot().tournamentId) <= 1
    ) {
      throw new StaffError('LAST_ADMINISTRATOR', 'The tournament must retain an active administrator.');
    }
  }

  private record(
    audit: StaffAuditWriter,
    action: StaffAuditEntry['action'],
    actorId: string,
    before: StaffMember | null,
    after: StaffMember,
  ): void {
    const snapshot = after.snapshot();
    audit.append({
      id: this.runtime.newId(),
      action,
      actorId,
      at: this.runtime.now(),
      tournamentId: snapshot.tournamentId,
      memberId: snapshot.id,
      before: before?.snapshot() ?? null,
      after: snapshot,
    });
  }
}
