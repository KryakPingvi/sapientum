export const STAFF_ROLES = ['jury', 'representative', 'author', 'administrator', 'organizer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type StaffStatus = 'active' | 'excluded';

export interface StaffMemberDto {
  readonly id: string;
  readonly tournamentId: string;
  readonly userId: string;
  readonly roles: readonly StaffRole[];
  readonly status: StaffStatus;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly excludedAt: string | null;
  readonly excludedBy: string | null;
  readonly version: number;
}

export interface AddStaffMemberRequest {
  userId: string;
  roles: StaffRole[];
}

export interface SetStaffRolesRequest {
  roles: StaffRole[];
  expectedVersion: number;
}

export interface ExcludeStaffMemberRequest {
  expectedVersion: number;
}
