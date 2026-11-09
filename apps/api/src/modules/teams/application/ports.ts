import type { TeamFilter } from '@sapientum/contracts/teams';
import type { Team } from '../domain/team.js';

export interface TeamRepository {
  insert(team: Team): Promise<void>;
  findById(tournamentId: string, teamId: string): Promise<Team | null>;
  confirm(team: Team): Promise<void>;
  list(tournamentId: string, status: TeamFilter): Promise<readonly Team[]>;
}

export interface TeamAccountDirectory {
  exists(userId: string): Promise<boolean>;
}

export interface TournamentDirectory {
  /** null means missing tournament. Mutations must hold a shared registration-state lock until commit. */
  registration(tournamentId: string): Promise<{ open: boolean } | null>;
}

export interface TeamContext {
  teams: TeamRepository;
  accounts: TeamAccountDirectory;
  tournaments: TournamentDirectory;
  requireOrganizer(tournamentId: string, actorId: string): Promise<void>;
}

export interface TeamTransaction {
  run<T>(operation: (context: TeamContext) => Promise<T>): Promise<T>;
}

export interface TeamRuntime {
  newId(): string;
  now(): string;
}
