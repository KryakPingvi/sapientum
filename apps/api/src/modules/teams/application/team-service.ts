import { TEAM_FILTERS, type TeamDto } from '@sapientum/contracts/teams';
import { TeamError } from '../domain/team-error.js';
import { Team, requireTeamId } from '../domain/team.js';
import type { TeamContext, TeamRuntime, TeamTransaction } from './ports.js';

export class TeamService {
  constructor(
    private readonly transactions: TeamTransaction,
    private readonly runtime: TeamRuntime,
  ) {}

  submit(input: {
    actorId: string;
    tournamentId: string;
    name: unknown;
    organization: unknown;
    leaderName: unknown;
  }): Promise<TeamDto> {
    return this.transactions.run(async (context) => {
      requireTeamId(input.actorId);
      const registration = await this.registration(context, input.tournamentId);
      if (!registration.open) throw new TeamError('REGISTRATION_CLOSED', 'Registration is closed.');
      if (!(await context.accounts.exists(input.actorId)))
        throw new TeamError('USER_NOT_FOUND', 'Account does not exist.');
      const team = Team.submit({ ...input, leaderId: input.actorId, id: this.runtime.newId(), at: this.runtime.now() });
      await context.teams.insert(team);
      return team.snapshot();
    });
  }

  confirm(input: { actorId: string; tournamentId: string; teamId: string }): Promise<TeamDto> {
    return this.transactions.run(async (context) => {
      requireTeamId(input.tournamentId);
      requireTeamId(input.actorId);
      await context.requireOrganizer(input.tournamentId, input.actorId);
      await this.registration(context, input.tournamentId);
      requireTeamId(input.teamId);
      const before = await context.teams.findById(input.tournamentId, input.teamId);
      if (!before) throw new TeamError('NOT_FOUND', 'Team does not exist in this tournament.');
      const team = before.confirm(input.actorId, this.runtime.now());
      await context.teams.confirm(team);
      return team.snapshot();
    });
  }

  list(input: { tournamentId: string; status: string }): Promise<readonly TeamDto[]> {
    return this.transactions.run(async (context) => {
      const status = TEAM_FILTERS.find((value) => value === input.status);
      if (!status) {
        throw new TeamError('INVALID_INPUT', 'Unknown team status.');
      }
      await this.registration(context, input.tournamentId);
      return (await context.teams.list(input.tournamentId, status)).map((team) => team.snapshot());
    });
  }

  private async registration(context: TeamContext, tournamentId: string) {
    requireTeamId(tournamentId);
    const state = await context.tournaments.registration(tournamentId);
    if (!state) throw new TeamError('TOURNAMENT_NOT_FOUND', 'Tournament does not exist.');
    return state;
  }
}
