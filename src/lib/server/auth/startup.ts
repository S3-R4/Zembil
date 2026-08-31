/**
 * Process startup and shutdown — CONTRACT.md §3.8 and §6.
 *
 * Imported by `src/hooks.server.ts`, which SvelteKit evaluates once before the
 * server listens. Kept in its own module so tests can drive each step against a
 * temporary database without importing the hooks themselves.
 */
import { closeAllStreams } from '../realtime/bus.js';
import type { Db } from '../db/index.js';
import { reapExpiredSessions } from './session.js';
import { reapExpiredChallenges } from './webauthn.js';
import { bootstrapFirstAdmin } from './users.js';
import type { AuthConfig } from './config.js';

/** §3.7: "A single timer started at boot runs every 10 minutes." */
export const REAP_INTERVAL_MS = 10 * 60_000;

export function reapOnce(db: Db): { sessions: number; challenges: number } {
	return { sessions: reapExpiredSessions(db), challenges: reapExpiredChallenges(db) };
}

let reaper: NodeJS.Timeout | null = null;

export function startReaper(db: Db): void {
	if (reaper !== null) return;
	reaper = setInterval(() => {
		try {
			reapOnce(db);
		} catch (err) {
			// A failed reap bounds disk badly but must never take the process down.
			console.error('[zembil] expiry reap failed', err);
		}
	}, REAP_INTERVAL_MS);
	// The HTTP server holds the event loop open; the reaper should not be the
	// reason a script or a test refuses to exit.
	reaper.unref();
}

export function stopReaper(): void {
	if (reaper === null) return;
	clearInterval(reaper);
	reaper = null;
}

/**
 * §3.8: bootstrap runs in-process, after migrations and before the server
 * listens — the brief requires the app to come up with a single
 * `docker compose up`, so first-admin creation cannot be a step an operator has
 * to know to run.
 */
export async function runBootstrap(db: Db, config: AuthConfig): Promise<void> {
	const result = await bootstrapFirstAdmin(db, {
		username: config.bootstrapUsername,
		password: config.bootstrapPassword
	});
	if (!result.created) return;
	if (result.generatedPassword === undefined) {
		console.warn(
			`[zembil] Bootstrapped the first admin account "${result.username}" with the password from ` +
				'ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD. It must be changed at first sign-in.'
		);
		return;
	}
	// §3.8: logged ONCE, at warn, as the only copy that will ever exist. The
	// account carries must_change_password, so this is a handoff credential.
	console.warn(
		'\n' +
			'  ┌───────────────────────────────────────────────────────────────┐\n' +
			'  │  Zembil first-admin account created.                          │\n' +
			'  │  This password is shown ONCE and is not stored anywhere.      │\n' +
			'  └───────────────────────────────────────────────────────────────┘\n' +
			`      username: ${result.username}\n` +
			`      password: ${result.generatedPassword}\n` +
			'      You will be required to change it at first sign-in.\n'
	);
}

/**
 * §3.8 graceful shutdown. Registered once; a second SIGTERM while the first is
 * still unwinding is ignored rather than re-entering.
 */
let shuttingDown = false;

export function shutdown(db: Db, exit: (code: number) => void = process.exit): void {
	if (shuttingDown) return;
	shuttingDown = true;
	stopReaper();
	try {
		closeAllStreams();
	} catch (err) {
		console.error('[zembil] closing SSE streams failed', err);
	}
	try {
		// A container killed mid-checkpoint leaves a `-wal` file that is
		// recoverable but makes a file-copy backup inconsistent — which is
		// precisely when an operator discovers their backups were never any good.
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	} catch (err) {
		console.error('[zembil] WAL checkpoint failed', err);
	}
	try {
		db.close();
	} catch (err) {
		console.error('[zembil] closing the database failed', err);
	}
	exit(0);
}

export function registerShutdown(db: Db): void {
	const handler = () => shutdown(db);
	process.once('SIGTERM', handler);
	process.once('SIGINT', handler);
}

/** Test seam — `shutdown` is one-shot by design. */
export function resetShutdownState(): void {
	shuttingDown = false;
}
