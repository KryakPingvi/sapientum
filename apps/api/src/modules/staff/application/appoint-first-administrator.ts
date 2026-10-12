import type { StaffMemberDto } from '@sapientum/contracts/staff';
import { StaffMember, requireId } from '../domain/staff-member.js';
import { StaffError } from '../domain/staff-error.js';
import type { AccountDirectory, StaffRuntime, StaffTransaction } from './ports.js';

/** Internal provisioning operation. Invoke only after tournament creation/ownership authorization. Never expose as a public route. */
export class AppointFirstAdministrator {
  constructor(private readonly transactions: StaffTransaction, private readonly accounts: AccountDirectory,
    private readonly runtime: StaffRuntime) {}

  execute(input: { tournamentId: string; userId: string; actorId: string }): StaffMemberDto {
    return this.transactions.run(({ members, audit }) => {
      for (const id of [input.tournamentId, input.userId, input.actorId]) requireId(id);
      if (!this.accounts.exists(input.userId)) throw new StaffError('USER_NOT_FOUND', 'Account does not exist.');
      if (members.countMembers(input.tournamentId) !== 0) {
        throw new StaffError('ALREADY_INITIALIZED', 'The organizing committee is already initialized.');
      }
      const member = StaffMember.add({ ...input, id: this.runtime.newId(), at: this.runtime.now(),
        roles: ['administrator', 'organizer'] });
      members.insert(member);
      const after = member.snapshot();
      audit.append({ id: this.runtime.newId(), action: 'first-administrator-appointed',
        tournamentId: input.tournamentId, memberId: after.id, actorId: input.actorId,
        at: this.runtime.now(), before: null, after });
      return after;
    });
  }
}
