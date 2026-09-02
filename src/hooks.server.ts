/**
 * Process startup — CONTRACT.md §3.8, §6, §8.7, §8.8.
 *
 * SvelteKit evaluates this module once, at process start, before the server
 * listens. §6: migrations run here and any failure must CRASH the process —
 * not be discovered lazily by whichever request arrives first and turned into a
 * 500 while the container reports itself healthy.
 *
 * The per-request logic lives in `$lib/server/auth/handle`, which takes the
 * connection and the configuration as arguments so it can be tested.
 */
import { getDb } from '$lib/server/db';
import { getConfig } from '$lib/server/auth/config';
import { createHandle } from '$lib/server/auth/handle';
import { registerShutdown, runBootstrap, startReaper } from '$lib/server/auth/startup';
import { configureNotifier, setNotificationSink } from '$lib/server/notify';
import { createPushSink } from '$lib/server/push';

// The order is normative (§6): configuration, then the database — which opens
// and migrates on first use — then bootstrap, then the reaper. Top-level await:
// SvelteKit awaits this module's evaluation, so a rejection here leaves an
// unstarted process rather than a running one with no admin.
const config = getConfig();
const db = getDb();
await runBootstrap(db, config);
startReaper(db);
registerShutdown(db);

// §8.8: the notifier is a pure coalescer that holds no database handle and does
// no I/O. This is the only place the two halves meet — the domain layer calls
// `noteItemAdded`, and what eventually happens to that batch is decided here.
//
// With push switched off no sink is installed, and with no sink the coalescer
// does not even accumulate: `ZEMBIL_PUSH_ENABLED=0` costs nothing on the add
// path rather than filling batches nobody will ever deliver.
configureNotifier({
	quietMs: config.notifyQuietMinutes * 60_000,
	maxDelayMs: config.notifyMaxDelayMinutes * 60_000
});
setNotificationSink(config.pushEnabled ? createPushSink(db, config) : null);

export const handle = createHandle(db, config);
