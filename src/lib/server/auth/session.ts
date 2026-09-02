/**
 * Session lifecycle — CONTRACT.md §1.1 (`sessions` table), §5 (cookie contract), D-004.
 *
 * Tokens are 32 random bytes; the database stores only `sha256(token)` hex
 * (I-9: the raw token never appears anywhere a client-supplied read could
 * reach). Idle and absolute expiry are enforced here, server-side — the
 * cookie's own `Max-Age` is a convenience only.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { fromBool } from '../db/index.js';
import type { Locale, User } from '$lib/types';
import { DEFAULT_LOCALE } from '$lib/types';
import { getConfig } from './config.js';

export type AuthMethod = 'password' | 'passkey';

const DAY_MS = 24 * 60 * 60 * 1000;
/** §5: "slid forward at most once per hour to avoid a write on every request." */
const SLIDE_INTERVAL_MS = 60 * 60 * 1000;
const USER_AGENT_MAX = 256;

function now(): number {
	return Date.now();
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface NewSession {
	/** The raw token — exists only here and in the cookie. Never stored. */
	token: string;
	sessionId: string;
	idleExpiresAt: number;
	absoluteExpiresAt: number;
}

/** Creates a session row. Callers set the cookie with the returned raw token. */
export function createSession(
	db: Db,
	userId: string,
	authMethod: AuthMethod,
	userAgent: string | null | undefined
): NewSession {
	const config = getConfig();
	const token = randomBytes(32).toString('base64url');
	const sessionId = hashToken(token);
	const ts = now();
	const idleExpiresAt = ts + config.sessionIdleDays * DAY_MS;
	const absoluteExpiresAt = ts + config.sessionAbsoluteDays * DAY_MS;
	const ua = userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null;

	db.prepare(
		`INSERT INTO sessions (id, user_id, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at, user_agent)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(sessionId, userId, authMethod, ts, ts, idleExpiresAt, absoluteExpiresAt, ua);

	return { token, sessionId, idleExpiresAt, absoluteExpiresAt };
}

interface SessionJoinRow {
	session_id: string;
	last_seen_at: number;
	idle_expires_at: number;
	absolute_expires_at: number;
	u_id: string;
	username: string;
	display_name: string;
	is_admin: number;
	is_active: number;
	must_change_password: number;
	created_at: number;
	locale: string;
}

const RESOLVE_SQL = `
  SELECT s.id AS session_id, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
         u.id AS u_id, u.username, u.display_name, u.is_admin, u.is_active,
         u.must_change_password, u.created_at, u.locale
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.id = ?
`;

function toUser(row: SessionJoinRow): User {
	return {
		id: row.u_id,
		username: row.username,
		displayName: row.display_name,
		isAdmin: fromBool(row.is_admin),
		isActive: fromBool(row.is_active),
		mustChangePassword: fromBool(row.must_change_password),
		createdAt: Number(row.created_at),
		// §8.5: the column is the ONLY source of a member's language. This is the
		// `User` that lands in `locals.user`, so every request-time read of the
		// locale comes from here and never from `Accept-Language`.
		locale: (row.locale as Locale) ?? DEFAULT_LOCALE
	};
}

export interface ResolvedSession {
	user: User;
	sessionId: string;
	/** Set when the idle window was just slid forward — callers refresh the cookie's Max-Age. */
	slidIdleExpiresAt: number | null;
}

/**
 * Looks up a session by its raw cookie token. Returns `null` for a missing,
 * expired, or disabled-account session — the caller (hooks.server.ts) must
 * treat all three identically: an unauthenticated request.
 *
 * Expiry is checked here, on read (§3.7): a session past either
 * `idle_expires_at` or `absolute_expires_at` is deleted opportunistically and
 * never resolves, regardless of whether the 10-minute reaper has run yet.
 */
export function resolveSession(db: Db, token: string): ResolvedSession | null {
	const sessionId = hashToken(token);
	const row = db.prepare(RESOLVE_SQL).get(sessionId) as unknown as SessionJoinRow | undefined;
	if (!row) return null;

	const ts = now();
	if (ts >= Number(row.idle_expires_at) || ts >= Number(row.absolute_expires_at)) {
		db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
		return null;
	}

	// A disabled account's sessions are destroyed by the admin flow that
	// disabled it (CONTRACT.md §3.3), but a session must never resolve for a
	// disabled user even if that row somehow still exists.
	if (!fromBool(row.is_active)) return null;

	let slidIdleExpiresAt: number | null = null;
	if (ts - Number(row.last_seen_at) >= SLIDE_INTERVAL_MS) {
		const config = getConfig();
		// Never let sliding push the idle window past the absolute ceiling.
		const idleExpiresAt = Math.min(
			ts + config.sessionIdleDays * DAY_MS,
			Number(row.absolute_expires_at)
		);
		db.prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?').run(
			ts,
			idleExpiresAt,
			sessionId
		);
		slidIdleExpiresAt = idleExpiresAt;
	}

	return { user: toUser(row), sessionId, slidIdleExpiresAt };
}

/** Deletes one session by its row id (the sha256 hash, not the raw token). */
export function destroySessionById(db: Db, sessionId: string): void {
	db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/** Deletes every session for a user. Returns the destroyed row ids (for bus revocation). */
export function destroyAllSessionsForUser(db: Db, userId: string): string[] {
	const rows = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as unknown as Array<{
		id: string;
	}>;
	db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
	return rows.map((r) => r.id);
}

/**
 * Deletes every session for a user EXCEPT the one given. Used by password
 * change (D-004, §3.2): the current session is rotated, not destroyed, and
 * must keep its live SSE stream — the destroyed ones must not.
 */
export function destroyOtherSessions(db: Db, userId: string, keepSessionId: string): string[] {
	const rows = db
		.prepare('SELECT id FROM sessions WHERE user_id = ? AND id <> ?')
		.all(userId, keepSessionId) as unknown as Array<{ id: string }>;
	db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSessionId);
	return rows.map((r) => r.id);
}

/** §3.7 reaper: deletes every session past either expiry, regardless of user. */
export function reapExpiredSessions(db: Db): number {
	const ts = now();
	const result = db
		.prepare('DELETE FROM sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?')
		.run(ts, ts);
	return Number(result.changes);
}
