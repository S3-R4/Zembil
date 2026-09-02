/**
 * Test support — PLAN.md §6: every test runs migrations into a fresh temporary
 * database FILE, never `:memory:`, so WAL and `busy_timeout` behave exactly as
 * they will in production.
 *
 * Lives under tests/domain/ because that is a directory this agent owns; the
 * tests in tests/db/ import it relatively.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, type Db, type OpenOptions } from '$lib/server/db';
import type { ZembilEvent } from '$lib/types';
import { resetBus, subscribe } from '$lib/server/realtime/bus';

export interface Harness {
	db: Db;
	dir: string;
	file: string;
	/** A second handle on the same file, for the concurrency tests. */
	second(options?: OpenOptions): Db;
	close(): void;
}

export function harness(options: OpenOptions = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), 'zembil-test-'));
	const file = join(dir, 'zembil.db');
	const db = openDatabase(file, options);
	const extra: Db[] = [];
	return {
		db,
		dir,
		file,
		second(opts: OpenOptions = {}) {
			const h = openDatabase(file, { migrate: false, ...opts });
			extra.push(h);
			return h;
		},
		close() {
			for (const h of extra) {
				try {
					h.close();
				} catch {
					/* already closed */
				}
			}
			try {
				db.close();
			} catch {
				/* already closed */
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

export interface TestUser {
	id: string;
	username: string;
	displayName: string;
}

/** Auth does not exist in M1, so tests construct users directly in the database. */
export function makeUser(db: Db, username = 'ayse', displayName = 'Ayse'): TestUser {
	const id = randomUUID();
	const ts = Date.now();
	db.prepare(
		`INSERT INTO users (id, username, username_key, display_name, password_hash,
		                    is_admin, is_active, must_change_password, webauthn_user_handle,
		                    created_at, updated_at, disabled_at)
		 VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, NULL)`
	).run(
		id,
		username,
		username.normalize('NFKC').toLowerCase(),
		displayName,
		'scrypt$N=65536,r=8,p=1$c2FsdA$a2V5',
		randomBytes(32),
		ts,
		ts
	);
	return { id, username, displayName };
}

/** Collects everything the in-process bus fans out during a test. */
export function recorder(userId = 'u', sessionId = 's') {
	resetBus();
	const events: ZembilEvent[] = [];
	const unsubscribe = subscribe(
		userId,
		sessionId,
		(e) => {
			events.push(e);
		},
		() => {}
	);
	return {
		events,
		take(): ZembilEvent[] {
			const copy = [...events];
			events.length = 0;
			return copy;
		},
		stop() {
			unsubscribe();
			resetBus();
		}
	};
}

/**
 * Minimal `App.Locals` for calling a route handler directly.
 *
 * `isAdmin` is a parameter rather than a constant because §8.4 turns "is this
 * caller an admin" into a question worth asking of every store-scoped endpoint:
 * the answer is that it changes nothing, and a test cannot assert that against a
 * helper that can only build non-admins.
 */
export function localsFor(
	user: TestUser | null,
	sessionId = 'session-1',
	options: { isAdmin?: boolean } = {}
) {
	return {
		user: user
			? {
					id: user.id,
					username: user.username,
					displayName: user.displayName,
					isAdmin: options.isAdmin ?? false,
					isActive: true,
					mustChangePassword: false,
					createdAt: Date.now(),
					locale: 'en' as const
				}
			: null,
		sessionId: user ? sessionId : null
	};
}

/** A `Request` shaped like the JSON the API actually receives. */
export function jsonRequest(body: unknown, method = 'POST'): Request {
	return new Request('http://localhost/api', {
		method,
		headers: { 'content-type': 'application/json', origin: 'http://localhost' },
		body: JSON.stringify(body)
	});
}

export async function bodyOf(response: Response): Promise<any> {
	return JSON.parse(await response.text());
}
