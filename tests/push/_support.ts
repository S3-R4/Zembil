/**
 * Push test support — PLAN.md §6 / PROJECT.md §11.
 *
 * Same shape as `tests/domain/_support.ts`: a real temporary SQLite FILE per
 * suite, migrated, never `:memory:`. Nothing here mocks the database, the
 * recipient query or the payload composition — the only seam in the whole push
 * suite is `setPushTransport`, at the outbound HTTPS boundary.
 *
 * It is a copy rather than an import because `tests/domain/_support.ts` belongs
 * to another agent and predates `users.locale`, `users.is_active` variation and
 * `stores.private_to`, all three of which these tests must set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, type Db } from '$lib/server/db';
import type { Locale } from '$lib/types';

export interface Harness {
	db: Db;
	dir: string;
	file: string;
	close(): void;
}

export function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), 'zembil-push-'));
	const file = join(dir, 'zembil.db');
	const db = openDatabase(file);
	return {
		db,
		dir,
		file,
		close() {
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
	locale: Locale;
	isActive: boolean;
}

export interface MakeUserOptions {
	username?: string;
	displayName?: string;
	locale?: Locale;
	isActive?: boolean;
	isAdmin?: boolean;
}

export function makeUser(db: Db, options: MakeUserOptions = {}): TestUser {
	const username = options.username ?? `user-${randomBytes(4).toString('hex')}`;
	const displayName = options.displayName ?? username;
	const locale: Locale = options.locale ?? 'en';
	const isActive = options.isActive ?? true;
	const id = randomUUID();
	const ts = Date.now();
	db.prepare(
		`INSERT INTO users (id, username, username_key, display_name, password_hash,
		                    is_admin, is_active, must_change_password, webauthn_user_handle,
		                    created_at, updated_at, disabled_at, locale)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
	).run(
		id,
		username,
		username.normalize('NFKC').toLowerCase(),
		displayName,
		'scrypt$N=65536,r=8,p=1$c2FsdA$a2V5',
		options.isAdmin ? 1 : 0,
		// §1.1a: a JS boolean cannot be bound. Converted here, at the boundary.
		isActive ? 1 : 0,
		randomBytes(32),
		ts,
		ts,
		isActive ? null : ts,
		locale
	);
	return { id, username, displayName, locale, isActive };
}

export interface TestStore {
	id: string;
	name: string;
}

export function makeStore(db: Db, name = 'Migros', privateTo: string | null = null): TestStore {
	const id = randomUUID();
	const ts = Date.now();
	db.prepare(
		`INSERT INTO stores (id, name, name_key, color, sort_order, rev, created_at, created_by,
		                     archived_at, private_to)
		 VALUES (?, ?, ?, 'terracotta', 1000, 1, ?, NULL, NULL, ?)`
	).run(id, name, name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(), ts, privateTo);
	return { id, name };
}

let endpointCounter = 0;

export function endpointFor(label = 'e'): string {
	endpointCounter += 1;
	return `https://push.example.com/${label}/${endpointCounter}`;
}

/** Inserts a subscription row directly — the route path is tested separately. */
export function makeSubscription(db: Db, userId: string, endpoint = endpointFor()): string {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO push_subscriptions
		   (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, failure_count)
		 VALUES (?, ?, ?, 'BPublicKeyMaterial', 'AuthSecret', 'test-agent', ?, NULL, 0)`
	).run(id, userId, endpoint, Date.now());
	return id;
}

/** Minimal `App.Locals` for calling a route handler directly. */
export function localsFor(user: TestUser | null, sessionId = 'session-1') {
	return {
		user: user
			? {
					id: user.id,
					username: user.username,
					displayName: user.displayName,
					isAdmin: false,
					isActive: user.isActive,
					mustChangePassword: false,
					createdAt: Date.now(),
					locale: user.locale
				}
			: null,
		sessionId: user ? sessionId : null
	};
}

export function jsonRequest(body: unknown, method = 'POST'): Request {
	return new Request('http://localhost/api/push/subscription', {
		method,
		headers: {
			'content-type': 'application/json',
			origin: 'http://localhost',
			'user-agent': 'Mozilla/5.0 (Test)'
		},
		body: JSON.stringify(body)
	});
}

export async function bodyOf(response: Response): Promise<any> {
	return JSON.parse(await response.text());
}

export const call = (fn: any, args: any) => fn(args) as Promise<Response>;
