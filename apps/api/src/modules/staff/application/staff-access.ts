import type { StaffRole } from '@sapientum/contracts/staff';
import { requireId } from '../domain/staff-member.js';
import { StaffError } from '../domain/staff-error.js';
import type { StaffReader } from './ports.js';

const PERMISSION_ROLES = {
  'staff.manage': ['administrator'],
  'reviews.check': ['jury'],
  'answers.submit': ['representative'],
  'tasks.manage': ['author'],
  'tournament.manage': ['organizer'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type StaffPermission = keyof typeof PERMISSION_ROLES;

export class StaffAccess {
  constructor(private readonly reader: StaffReader) {}

  allows(tournamentId: string, userId: string, permission: StaffPermission): boolean {
    requireId(tournamentId);
    requireId(userId);
    const member = this.reader.findByUser(tournamentId, userId);
    return PERMISSION_ROLES[permission].some(role => member?.hasRole(role) === true);
  }

  require(tournamentId: string, userId: string, permission: StaffPermission): void {
    if (!this.allows(tournamentId, userId, permission)) {
      throw new StaffError('FORBIDDEN', 'You do not have permission in this tournament.');
    }
  }
}
