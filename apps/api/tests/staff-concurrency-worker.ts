import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { SqliteStaffStore, StaffService, StaffError } from '../src/modules/staff/index.js';

const input = workerData as { path: string; actorId: string; memberId: string };
const store = new SqliteStaffStore(input.path);
const service = new StaffService(store, { exists: () => true }, { newId: randomUUID, now: () => new Date().toISOString() });
parentPort!.postMessage('ready');
parentPort!.once('message', () => {
  try {
    service.exclude({ actorId: input.actorId, tournamentId: 't1', memberId: input.memberId, expectedVersion: 1 });
    parentPort!.postMessage('ok');
  } catch (error) {
    if (!(error instanceof StaffError)) throw error;
    parentPort!.postMessage(error.code);
  } finally { store.close(); parentPort!.close(); }
});
