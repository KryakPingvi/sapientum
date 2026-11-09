export class TeamError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'USER_NOT_FOUND'
      | 'TOURNAMENT_NOT_FOUND'
      | 'REGISTRATION_CLOSED'
      | 'NOT_FOUND'
      | 'DUPLICATE_NAME'
      | 'ALREADY_CONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}
