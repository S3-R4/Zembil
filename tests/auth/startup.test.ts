/** CONTRACT.md §3.8 (health, bootstrap, shutdown), §6 (env), §3.7 (the reaper). */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as healthRoute } from '../../src/routes/api/health/+server';
import { POST as login } from '../../src/routes/api/auth/login/+server';
import {
	REAP_INTERVAL_MS,
	reapOnce,
	resetShutdownState,
	runBootstrap,
	shutdown,
	startReaper,
	stopReaper
} from '$lib/server/auth/startup';
import { bootstrapFirstAdmin } from '$lib/server/auth/users';
import { loadConfig } from '$lib/server/auth/config';
import { createSession } from '$lib/server/auth/session';
import { streamCount, subscribe } from '$lib/server/realtime/bus';
import { authHarness, bodyOf, routeEvent, seedUser, type AuthHarness } from './_support';

let h: AuthHarness;

beforeEach(() => {
	h = authHarness();
	resetShutdownState();
});
afterEach(() => {
	stopReaper();
	h.close();
});

describe('GET /api/health (§3.8)', () => {
	it('returns exactly {"status":"ok"} and no-store, and nothing else at all', async () => {
		const response = await healthRoute(routeEvent({ method: 'GET', path: '/api/health' }) as any);
		expect(response.status).toBe(200);
		const body = await bodyOf(response);
		// No version, no uptime, no migration number, no user count, no error text:
		// this endpoint is reachable from the public internet by anyone who finds
		// the hostname, and a health endpoint that reports the build is a free
		// fingerprint for picking a matching CVE.
		expect(body).toEqual({ status: 'ok' });
		expect(Object.keys(body)).toEqual(['status']);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('returns 503 when the database is gone', async () => {
		h.db.close();
		const response = await healthRoute(routeEvent({ method: 'GET', path: '/api/health' }) as any);
		// The 503 is what makes it worth having: the container must report
		// unhealthy when the database is gone, or Docker restarts nothing while
		// every real request 500s.
		expect(response.status).toBe(503);
		expect(await bodyOf(response)).toEqual({ status: 'unavailable' });
	});
});

describe('bootstrap (§3.8, §6)', () => {
	it('creates the first admin, flagged to change the password, and logs it once', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await runBootstrap(h.db, loadConfig());

		const row = h.db.prepare('SELECT * FROM users').get() as any;
		expect(row.username).toBe('admin');
		expect([row.is_admin, row.is_active, row.must_change_password]).toEqual([1, 1, 1]);
		expect(row.password_hash).toMatch(/^scrypt\$/);
		expect(Buffer.from(row.webauthn_user_handle)).toHaveLength(32);

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls[0].join(' ');
		const password = logged.match(/password: (\S+)/)![1];
		expect(password).toHaveLength(20);
		warn.mockRestore();

		// The password in the log is the password that works.
		const response = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'admin', password }
		}) as any);
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).mustChangePassword).toBe(true);
	});

	it('is idempotent — a restart never resets an existing admin (§6)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await runBootstrap(h.db, loadConfig());
		const first = h.db.prepare('SELECT id, password_hash FROM users').get() as any;

		await runBootstrap(h.db, loadConfig());
		await runBootstrap(h.db, loadConfig());
		warn.mockRestore();

		const rows = h.db.prepare('SELECT id, password_hash FROM users').all() as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].password_hash).toBe(first.password_hash);
	});

	it('loses a race with a second writer rather than creating a second admin', async () => {
		// The check inside the transaction, not the cheap one before it. Bootstrap
		// awaits a scrypt between reading the count and opening the transaction,
		// and `scripts/bootstrap-admin.js` can be running against the same file
		// from another process while the container starts. The in-transaction
		// re-read under BEGIN IMMEDIATE is what makes that safe; without it this
		// creates a second account on a table it already found empty.
		const pending = bootstrapFirstAdmin(h.db, { username: 'admin', password: null });
		// Written synchronously, so it is committed before bootstrap's scrypt
		// resolves rather than racing another scrypt of its own.
		const ts = Date.now();
		h.db
			.prepare(
				`INSERT INTO users (id, username, username_key, display_name, password_hash, is_admin,
				                    is_active, must_change_password, webauthn_user_handle,
				                    created_at, updated_at, disabled_at)
				 VALUES ('other', 'ayse', 'ayse', 'Ayse', 'scrypt$N=1,r=1,p=1$aa$bb', 0, 1, 0, ?, ?, ?, NULL)`
			)
			.run(randomBytes(32), ts, ts);
		const result = await pending;

		expect(result.created).toBe(false);
		const rows = h.db.prepare('SELECT username FROM users').all() as any[];
		expect(rows.map((r) => r.username)).toEqual(['ayse']);
	});

	it('does not even hash on a restart — the cheap check comes before the scrypt', async () => {
		await seedUser(h.db, { username: 'ayse' });
		const t0 = process.hrtime.bigint();
		await bootstrapFirstAdmin(h.db, { username: 'admin', password: null });
		const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
		// One scrypt at N=65536 is tens of milliseconds and runs before the server
		// listens. The outcome is identical either way, so cost is the only thing
		// that distinguishes the early exit from the in-transaction guard.
		expect(elapsed).toBeLessThan(25);
	});

	it('does nothing when ANY user already exists, not merely an admin', async () => {
		await seedUser(h.db, { username: 'ayse' });
		const result = await bootstrapFirstAdmin(h.db, { username: 'admin', password: null });
		expect(result.created).toBe(false);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 1 });
	});

	it('uses the supplied password when one is given, and still sets the flag', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		h.close();
		h = authHarness({
			ZEMBIL_BOOTSTRAP_ADMIN_USERNAME: 'baba',
			ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD: 'a-supplied-password'
		});
		await runBootstrap(h.db, loadConfig());
		const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
		// A supplied password is not echoed to the log — it already exists
		// somewhere the operator controls.
		expect(logged).not.toContain('a-supplied-password');
		warn.mockRestore();

		const response = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'baba', password: 'a-supplied-password' }
		}) as any);
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).mustChangePassword).toBe(true);
	});

	it('rejects a supplied password that is too short rather than creating a weak admin', async () => {
		await expect(
			bootstrapFirstAdmin(h.db, { username: 'admin', password: 'short' })
		).rejects.toThrow(/at least 12/);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 0 });
	});
});

describe('the reaper (§3.7)', () => {
	it('runs every 10 minutes', () => {
		expect(REAP_INTERVAL_MS).toBe(10 * 60_000);
	});

	it('deletes expired sessions and challenges in one pass', async () => {
		const ayse = await seedUser(h.db);
		const session = createSession(h.db, ayse.id, 'password', null);
		h.db
			.prepare('UPDATE sessions SET idle_expires_at = ? WHERE id = ?')
			.run(Date.now() - 1, session.sessionId);
		h.db
			.prepare(
				`INSERT INTO webauthn_challenges (id, challenge, user_id, purpose, created_at, expires_at)
				 VALUES ('c1', 'x', NULL, 'authentication', ?, ?)`
			)
			.run(Date.now() - 10_000, Date.now() - 1);

		expect(reapOnce(h.db)).toEqual({ sessions: 1, challenges: 1 });
	});

	it('starts once and is idempotent', () => {
		expect(() => {
			startReaper(h.db);
			startReaper(h.db);
			stopReaper();
		}).not.toThrow();
	});
});

describe('graceful shutdown (§3.8)', () => {
	it('closes every SSE stream, checkpoints the WAL, closes the database and exits 0', () => {
		let closed = false;
		subscribe('u', 's', () => {}, () => {
			closed = true;
		});
		expect(streamCount()).toBe(1);

		const exit = vi.fn();
		shutdown(h.db, exit);

		// An SSE response never ends on its own: without this, SIGTERM waits for
		// the container's kill timeout instead of exiting 0.
		expect(closed).toBe(true);
		expect(streamCount()).toBe(0);
		expect(exit).toHaveBeenCalledWith(0);
		// The connection really is closed, not merely marked.
		expect(() => h.db.prepare('SELECT 1').get()).toThrow();
	});

	it('is one-shot: a second SIGTERM while the first unwinds does nothing', () => {
		const exit = vi.fn();
		shutdown(h.db, exit);
		shutdown(h.db, exit);
		expect(exit).toHaveBeenCalledTimes(1);
	});
});
