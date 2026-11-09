import type { TeamDto } from '@sapientum/contracts/teams';
import { TeamError } from './team-error.js';

export function requireTeamId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new TeamError('INVALID_INPUT', 'Identifier must be a nonempty string of at most 200 characters.');
  }
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > limit || value.includes('\0')) {
    throw new TeamError('INVALID_INPUT', `${field} must be a nonempty string of at most ${limit} characters.`);
  }
  return value.trim();
}

export class Team {
  private readonly state: TeamDto;

  private constructor(state: TeamDto) {
    this.state = Object.freeze({ ...state });
  }

  static submit(input: {
    id: string;
    tournamentId: string;
    leaderId: string;
    name: unknown;
    organization: unknown;
    leaderName: unknown;
    at: string;
  }): Team {
    for (const id of [input.id, input.tournamentId, input.leaderId]) requireTeamId(id);
    return new Team({
      id: input.id,
      tournamentId: input.tournamentId,
      leaderId: input.leaderId,
      name: text(input.name, 'name', 200),
      organization: text(input.organization, 'organization', 300),
      leaderName: text(input.leaderName, 'leaderName', 300),
      status: 'pending',
      submittedAt: input.at,
      confirmedAt: null,
      confirmedBy: null,
    });
  }

  static restore(snapshot: TeamDto): Team {
    return new Team(snapshot);
  }

  snapshot(): TeamDto {
    return this.state;
  }

  confirm(actorId: string, at: string): Team {
    requireTeamId(actorId);
    if (this.state.status !== 'pending') throw new TeamError('ALREADY_CONFIRMED', 'Team is already confirmed.');
    return new Team({ ...this.state, status: 'confirmed', confirmedBy: actorId, confirmedAt: at });
  }
}
