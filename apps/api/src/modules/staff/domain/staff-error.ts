export type StaffErrorCode =
  | 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'USER_NOT_FOUND'
  | 'DUPLICATE_MEMBER' | 'MEMBER_EXCLUDED' | 'LAST_ADMINISTRATOR'
  | 'VERSION_CONFLICT' | 'ALREADY_INITIALIZED';

export class StaffError extends Error {
  constructor(public readonly code: StaffErrorCode, message: string) {
    super(message);
    this.name = 'StaffError';
  }
}
