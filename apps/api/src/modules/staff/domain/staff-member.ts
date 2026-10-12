import { STAFF_ROLES, type StaffMemberDto, type StaffRole } from '@sapientum/contracts/staff';
import { StaffError } from './staff-error.js';

export function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new StaffError('INVALID_INPUT', 'Identifier must be a nonempty string of at most 200 characters.');
  }
}

export function normalizeRoles(value: unknown): readonly StaffRole[] {
  if (!Array.isArray(value) || value.some(role => !STAFF_ROLES.includes(role))) {
    throw new StaffError('INVALID_INPUT', 'Unknown staff role.');
  }
  return Object.freeze(STAFF_ROLES.filter(role => value.includes(role)));
}

/** Immutable snapshots: changes are made only through domain operations. */
export class StaffMember {
  private readonly state: StaffMemberDto;

  private constructor(state: StaffMemberDto) {
    this.state = Object.freeze({ ...state, roles: normalizeRoles(state.roles) });
  }

  static add(input: { id: string; tournamentId: string; userId: string; roles: unknown; actorId: string; at: string }): StaffMember {
    for (const id of [input.id, input.tournamentId, input.userId, input.actorId]) requireId(id);
    return new StaffMember({
      id: input.id, tournamentId: input.tournamentId, userId: input.userId,
      roles: normalizeRoles(input.roles), status: 'active',
      addedAt: input.at, addedBy: input.actorId, excludedAt: null, excludedBy: null, version: 1,
    });
  }

  static restore(snapshot: StaffMemberDto): StaffMember {
    return new StaffMember(snapshot);
  }

  snapshot(): StaffMemberDto { return this.state; }

  hasRole(role: StaffRole): boolean {
    return this.state.status === 'active' && this.state.roles.includes(role);
  }

  setRoles(roles: unknown, expectedVersion: number): StaffMember {
    this.assertEditable(expectedVersion);
    return new StaffMember({ ...this.state, roles: normalizeRoles(roles), version: this.state.version + 1 });
  }

  exclude(actorId: string, at: string, expectedVersion: number): StaffMember {
    requireId(actorId);
    this.assertEditable(expectedVersion);
    return new StaffMember({
      ...this.state, status: 'excluded', excludedBy: actorId, excludedAt: at, version: this.state.version + 1,
    });
  }

  private assertEditable(expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new StaffError('INVALID_INPUT', 'expectedVersion must be a positive integer.');
    }
    if (this.state.version !== expectedVersion) {
      throw new StaffError('VERSION_CONFLICT', 'Membership has changed; reload it before editing.');
    }
    if (this.state.status === 'excluded') {
      throw new StaffError('MEMBER_EXCLUDED', 'Excluded membership cannot be modified.');
    }
  }
}
