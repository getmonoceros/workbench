import { defineCommand } from 'citty';
import { runUpdateCheck } from '../update/notifier.js';

/**
 * Internal, hidden command run as a DETACHED background process by
 * `scheduleUpdateNotice` (update/notifier.ts) when the cached latest-version
 * is stale. It fetches the latest `@getmonoceros/workbench` version from npm
 * and caches it in machine-state for the next command to read — so the
 * foreground command never pays the network cost. Always exits 0; any failure
 * is swallowed (an update check must never surface an error).
 */
export const __updateCheckCommand = defineCommand({
  meta: {
    name: '__update-check',
    group: 'internal',
    hidden: true,
    description: 'Internal: refresh the cached latest-version (background).',
  },
  async run() {
    try {
      await runUpdateCheck();
    } catch {
      /* silent — background plumbing */
    }
  },
});
