/**
 * Auth test support — PLAN.md §6.
 *
 * Every test runs the real migrations into a fresh temporary database FILE and
 * drives the real route handlers. Nothing here stubs a guard: a test that
 * bypasses the thing it is asserting is the failure mode D-030 exists to catch.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cookies } from '@sveltejs/kit';
import { openDatabase, setDb, type Db } from '$lib/server/db';
import { resetBus } from '$lib/server/realtime/bus';
import { loadConfig, resetConfig, type AuthConfig } from '$lib/server/auth/config';
import { resetAllLimiters } from '$lib/server/auth/ratelimit';
import { hashPassword, usernameKey } from '$lib/server/auth/password';
import { createSession } from '$lib/server/auth/session';
import { cookieName } from '$lib/server/auth/cookies';

export const TEST_ORIGIN = 'https://zembil.test';
export const TEST_RP_ID = 'zembil.test';

export interface AuthHarness {
	db: Db;
	dir: string;
	file: string;
	config: AuthConfig;
	close(): void;
}

/**
 * Sets the environment BEFORE `resetConfig()`, because `getConfig()` caches on
 * first use and every module below reads it lazily through that cache.
 */
export function authHarness(env: Record<string, string> = {}): AuthHarness {
	const dir = mkdtempSync(join(tmpdir(), 'zembil-auth-'));
	const file = join(dir, 'zembil.db');
	const db = openDatabase(file);

	process.env.ZEMBIL_ORIGIN = TEST_ORIGIN;
	delete process.env.ZEMBIL_RP_ID;
	delete process.env.ZEMBIL_TRUST_PROXY;
	delete process.env.ZEMBIL_SESSION_IDLE_DAYS;
	delete process.env.ZEMBIL_SESSION_ABSOLUTE_DAYS;
	delete process.env.ZEMBIL_BOOTSTRAP_ADMIN_USERNAME;
	delete process.env.ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD;
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	resetConfig();
	const config = loadConfig();

	setDb(db);
	resetBus();
	resetAllLimiters();

	return {
		db,
		dir,
		file,
		config,
		close() {
			setDb(null);
			resetConfig();
			resetBus();
			resetAllLimiters();
			try {
				db.close();
			} catch {
				/* already closed */
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

export interface SeededUser {
	id: string;
	username: string;
	displayName: string;
	password: string;
	isAdmin: boolean;
}

/** Writes a user with a REAL scrypt hash, so the login tests exercise the real
 *  verification path rather than a placeholder that could never match. */
export async function seedUser(
	db: Db,
	options: {
		username?: string;
		displayName?: string;
		password?: string;
		isAdmin?: boolean;
		isActive?: boolean;
		mustChangePassword?: boolean;
	} = {}
): Promise<SeededUser> {
	const username = options.username ?? 'ayse';
	const displayName = options.displayName ?? 'Ayse';
	const password = options.password ?? 'correct-horse-battery';
	const isAdmin = options.isAdmin ?? false;
	const isActive = options.isActive ?? true;
	const id = randomUUID();
	const ts = Date.now();
	const { randomBytes } = await import('node:crypto');

	db.prepare(
		`INSERT INTO users (id, username, username_key, display_name, password_hash, is_admin,
		                    is_active, must_change_password, webauthn_user_handle,
		                    created_at, updated_at, disabled_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		username,
		usernameKey(username),
		displayName,
		await hashPassword(password),
		isAdmin ? 1 : 0,
		isActive ? 1 : 0,
		options.mustChangePassword ? 1 : 0,
		randomBytes(32),
		ts,
		ts,
		isActive ? null : ts
	);
	return { id, username, displayName, password, isAdmin };
}

// --------------------------------------------------------------------------
// A minimal `Cookies` that behaves the way a browser does for the attributes
// §5 cares about: a jar keyed by name, with `delete` removing the entry.
// --------------------------------------------------------------------------

export interface FakeCookies extends Cookies {
	jar: Map<string, { value: string; opts: Record<string, unknown> }>;
	deleted: string[];
}

export function fakeCookies(initial: Record<string, string> = {}): FakeCookies {
	const jar = new Map<string, { value: string; opts: Record<string, unknown> }>();
	for (const [k, v] of Object.entries(initial)) jar.set(k, { value: v, opts: {} });
	const deleted: string[] = [];
	const cookies = {
		jar,
		deleted,
		get: (name: string) => jar.get(name)?.value,
		getAll: () => [...jar].map(([name, entry]) => ({ name, value: entry.value })),
		set: (name: string, value: string, opts: Record<string, unknown>) => {
			jar.set(name, { value, opts });
		},
		delete: (name: string) => {
			deleted.push(name);
			jar.delete(name);
		},
		serialize: (name: string, value: string) => `${name}=${value}`
	};
	return cookies as unknown as FakeCookies;
}

export function localsOf(
	user: { id: string; username: string; displayName: string; isAdmin: boolean } | null,
	sessionId: string | null = null,
	overrides: Partial<App.Locals['user'] & object> = {}
): App.Locals {
	return {
		user: user
			? {
					id: user.id,
					username: user.username,
					displayName: user.displayName,
					isAdmin: user.isAdmin,
					isActive: true,
					mustChangePassword: false,
					createdAt: Date.now(),
					locale: 'en' as const,
					theme: 'auto' as const,
					...overrides
				}
			: null,
		sessionId
	};
}

/** Signs a seeded user in the way the app does, returning the raw cookie token. */
export function signIn(db: Db, userId: string): { token: string; sessionId: string } {
	const session = createSession(db, userId, 'password', 'vitest');
	return { token: session.token, sessionId: session.sessionId };
}

export function cookiesWithSession(token: string): FakeCookies {
	return fakeCookies({ [cookieName()]: token });
}

// --------------------------------------------------------------------------
// Route invocation
// --------------------------------------------------------------------------

export interface EventOptions {
	method?: string;
	path?: string;
	body?: unknown;
	/** Omit to send the correct one; pass `null` to send none at all. */
	origin?: string | null;
	locals?: App.Locals;
	cookies?: FakeCookies;
	params?: Record<string, string>;
	address?: string;
	headers?: Record<string, string>;
	/**
	 * The matched route pattern, when it differs from the request path — a
	 * percent-encoded path, or a parameterised route. SvelteKit decodes before
	 * matching, so these two are NOT the same string in general, and the
	 * `must_change_password` gate was bypassable precisely because the code
	 * assumed they were. Pass `null` for a request that matched no route.
	 */
	routeId?: string | null;
}

export function routeEvent(options: EventOptions = {}): any {
	const method = options.method ?? 'POST';
	const path = options.path ?? '/api/test';
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(options.headers ?? {})
	};
	const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
	if (origin !== null) headers.origin = origin;

	const url = new URL(`${TEST_ORIGIN}${path}`);
	const init: RequestInit = { method, headers };
	if (options.body !== undefined && method !== 'GET') {
		init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
	}

	return {
		request: new Request(url, init),
		url,
		locals: options.locals ?? localsOf(null),
		cookies: options.cookies ?? fakeCookies(),
		params: options.params ?? {},
		getClientAddress: () => options.address ?? '198.51.100.7',
		route: { id: options.routeId !== undefined ? options.routeId : path },
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false,
		platform: undefined,
		fetch,
		depends: () => {}
	};
}

export async function bodyOf(response: Response): Promise<any> {
	const text = await response.text();
	return text.length === 0 ? null : JSON.parse(text);
}
