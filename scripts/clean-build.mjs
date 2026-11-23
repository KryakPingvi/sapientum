import { rmSync } from 'node:fs';
// Fixed generated directories only. Clear stale tests when switching PR branches.
for (const relative of ['../apps/api/dist/', '../packages/contracts/dist/']) {
  rmSync(new URL(relative, import.meta.url), { recursive: true, force: true });
}
