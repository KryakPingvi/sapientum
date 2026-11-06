import type { StaffMemberDto } from '@sapientum/contracts/staff';
import { StaffMember, requireId } from '../domain/staff-member.js';
import { StaffError } from '../domain/staff-error.js';
import type { AccountDirectory, StaffRuntime, StaffTransaction } from './ports.js';

/** Internal provisioning operation. Invoke only after tournament creation/ownership authorization. Never expose as a public route. */
export class AppointFirstAdministrator {
  constructor(
    private readonly transactions: StaffTransaction,
    private readonly accounts: AccountDirectory,
    private readonly runtime: StaffRuntime,
  ) {}

  execute(input: { tournamentId: string; userId: string; actorId: string }): Promise<StaffMemberDto> {
    return this.transactions.run(async ({ members, audit }) => {
      for (const id of [input.tournamentId, input.userId, input.actorId]) requireId(id);
      await members.lockTournament(input.tournamentId);
      if (!(await this.accounts.exists(input.userId)))
        throw new StaffError('USER_NOT_FOUND', 'Account does not exist.');
      if ((await members.countMembers(input.tournamentId)) !== 0) {
        throw new StaffError('ALREADY_INITIALIZED', 'The organizing committee is already initialized.');
      }
      const member = StaffMember.add({
        ...input,
        id: this.runtime.newId(),
        at: this.runtime.now(),
        roles: ['administrator', 'organizer'],
      });
      await members.insert(member);
      const after = member.snapshot();
      await audit.append({
        id: this.runtime.newId(),
        action: 'first-administrator-appointed',
        tournamentId: input.tournamentId,
        memberId: after.id,
        actorId: input.actorId,
        at: this.runtime.now(),
        before: null,
        after,
      });
      return after;
    });
  }
}
