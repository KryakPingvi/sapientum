import type { StaffMemberDto } from '@sapientum/contracts/staff';
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

  add(input: { actorId: string; tournamentId: string; userId: unknown; roles: unknown }): Promise<StaffMemberDto> {
    return this.transactions.run(async ({ members, audit }) => {
      await members.lockTournament(input.tournamentId);
      await new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      const userId = input.userId;
      requireId(userId);
      if (!(await this.accounts.exists(userId))) throw new StaffError('USER_NOT_FOUND', 'Account does not exist.');
      if (await members.findByUser(input.tournamentId, userId)) {
        throw new StaffError('DUPLICATE_MEMBER', 'This account already has a membership, possibly excluded.');
      }
      const member = StaffMember.add({ ...input, userId, id: this.runtime.newId(), at: this.runtime.now() });
      await members.insert(member);
      await this.record(audit, 'member-added', input.actorId, null, member);
      return member.snapshot();
    });
  }

  setRoles(input: {
    actorId: string;
    tournamentId: string;
    memberId: string;
    roles: unknown;
    expectedVersion: unknown;
  }): Promise<StaffMemberDto> {
    return this.transactions.run(async ({ members, audit }) => {
      await members.lockTournament(input.tournamentId);
      await new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      const before = await this.get(members, input.tournamentId, input.memberId);
      const after = before.setRoles(input.roles, input.expectedVersion);
      await this.protectAdministrator(members, before, after);
      await members.update(after, before.snapshot().version);
      await this.record(audit, 'roles-assigned', input.actorId, before, after);
      return after.snapshot();
    });
  }

  exclude(input: {
    actorId: string;
    tournamentId: string;
    memberId: string;
    expectedVersion: unknown;
  }): Promise<StaffMemberDto> {
    return this.transactions.run(async ({ members, audit }) => {
      await members.lockTournament(input.tournamentId);
      await new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      const before = await this.get(members, input.tournamentId, input.memberId);
      const after = before.exclude(input.actorId, this.runtime.now(), input.expectedVersion);
      await this.protectAdministrator(members, before, after);
      await members.update(after, before.snapshot().version);
      await this.record(audit, 'member-excluded', input.actorId, before, after);
      return after.snapshot();
    });
  }

  list(input: { actorId: string; tournamentId: string; status: string }): Promise<readonly StaffMemberDto[]> {
    return this.transactions.run(async ({ members }) => {
      await new StaffAccess(members).require(input.tournamentId, input.actorId, 'staff.manage');
      if (input.status !== 'active' && input.status !== 'excluded') {
        throw new StaffError('INVALID_INPUT', 'Unknown membership status.');
      }
      const list = await members.list(input.tournamentId, input.status);
      return list.map((member) => member.snapshot());
    });
  }

  private async get(members: StaffRepository, tournamentId: string, memberId: string): Promise<StaffMember> {
    requireId(memberId);
    const member = await members.findById(tournamentId, memberId);
    if (!member) throw new StaffError('NOT_FOUND', 'Membership does not exist in this tournament.');
    return member;
  }

  private async protectAdministrator(members: StaffRepository, before: StaffMember, after: StaffMember) {
    if (
      before.hasRole('administrator') &&
      !after.hasRole('administrator') &&
      (await members.countAdministrators(before.snapshot().tournamentId)) <= 1
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
  ): Promise<void> {
    const snapshot = after.snapshot();
    return audit.append({
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
