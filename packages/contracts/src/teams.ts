export const TEAM_STATUSES = ['pending', 'confirmed'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];
export const TEAM_FILTERS = ['all', ...TEAM_STATUSES] as const;
export type TeamFilter = (typeof TEAM_FILTERS)[number];

export interface TeamDto {
  readonly id: string;
  readonly tournamentId: string;
  readonly leaderId: string;
  readonly name: string;
  readonly organization: string;
  readonly leaderName: string;
  readonly status: TeamStatus;
  readonly submittedAt: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
}

export interface SubmitTeamRequest {
  name: string;
  organization: string;
  leaderName: string;
}
