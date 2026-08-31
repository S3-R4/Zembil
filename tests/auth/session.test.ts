/** CONTRACT.md §5 (session and cookie contract), §1.1 (`sessions`), §3.7 (reaping). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createSession,
	destroyAllSessionsForUser,
	destroyOtherSessions,
	destroySessionById,
	hashToken,
	reapExpiredSessions,
	resolveSession
} from '$lib/server/auth/session';
import { authHarness, seedUser, type AuthHarness, type SeededUser } from './_support';

const DAY = 24 * 60 * 60 * 1000;

let h: AuthHarness;
let ayse: SeededUser;

beforeEach(async () => {
	h = authHarness();
	ayse = await seedUser(h.db);
});
afterEach(() => h.close());

function sessionRow(id: string) {
	return h.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
}

describe('session creation (§5, I-9)', () => {
	it('stores sha256(token) and never the token itself', () => {
		const session = createSession(h.db, ayse.id, 'password', 'vitest');
		expect(session.sessionId).toBe(hashToken(session.token));
		expect(session.sessionId).toMatch(/^[0-9a-f]{64}$/);

		// I-9: `sessions.id` is never equal to any value that was ever sent to a
		// client. Scan the whole row for the raw token, not just the id column —
		// a token accidentally copied into `user_agent` would be just as bad.
		const row = sessionRow(session.sessionId);
		for (const value of Object.values(row)) {
			expect(String(value)).not.toContain(session.token);
		}
	});

	it('sets both TTLs from the configuration, and never extends the absolute one', () => {
		const before = Date.now();
		const session = createSession(h.db, ayse.id, 'password', null);
		const row = sessionRow(session.sessionId);
		expect(Number(row.idle_expires_at) - before).toBeGreaterThanOrEqual(30 * DAY - 50);
		expect(Number(row.idle_expires_at) - before).toBeLessThanOrEqual(30 * DAY + 500);
		expect(Number(row.absolute_expires_at) - before).toBeGreaterThanOrEqual(180 * DAY - 50);
		expect(row.auth_method).toBe('password');
	});

	it('truncates the user agent to 256 characters (§1.1)', () => {
		const session = createSession(h.db, ayse.id, 'passkey', 'x'.repeat(500));
		expect(sessionRow(session.sessionId).user_agent).toHaveLength(256);
	});

	it('honours ZEMBIL_SESSION_IDLE_DAYS / _ABSOLUTE_DAYS', async () => {
		h.close();
		h = authHarness({ ZEMBIL_SESSION_IDLE_DAYS: '2', ZEMBIL_SESSION_ABSOLUTE_DAYS: '7' });
		const user = await seedUser(h.db);
		const before = Date.now();
		const session = createSession(h.db, user.id, 'password', null);
		const row = sessionRow(session.sessionId);
		expect(Number(row.idle_expires_at) - before).toBeLessThanOrEqual(2 * DAY + 500);
		expect(Number(row.absolute_expires_at) - before).toBeLessThanOrEqual(7 * DAY + 500);
	});
});

describe('resolveSession (§5, §3.7)', () => {
	it('resolves a live session to its user', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		const resolved = resolveSession(h.db, session.token);
		expect(resolved?.user.id).toBe(ayse.id);
		expect(resolved?.sessionId).toBe(session.sessionId);
		expect(resolved?.slidIdleExpiresAt).toBeNull();
	});

	it('returns null for an unknown token', () => {
		expect(resolveSession(h.db, 'not-a-token')).toBeNull();
	});

	it('refuses and deletes a session past its IDLE expiry', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		h.db
			.prepare('UPDATE sessions SET idle_expires_at = ? WHERE id = ?')
			.run(Date.now() - 1, session.sessionId);
		expect(resolveSession(h.db, session.token)).toBeNull();
		// Expiry is enforced on READ, not by the reaper — the row is gone already.
		expect(sessionRow(session.sessionId)).toBeUndefined();
	});

	it('refuses and deletes a session past its ABSOLUTE expiry even when idle is fine', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		// `CHECK (absolute_expires_at > created_at)` means the birth timestamp has
		// to move with it — the row cannot be born after it expires.
		h.db
			.prepare('UPDATE sessions SET created_at = ?, absolute_expires_at = ? WHERE id = ?')
			.run(Date.now() - 1000, Date.now() - 1, session.sessionId);
		expect(resolveSession(h.db, session.token)).toBeNull();
		expect(sessionRow(session.sessionId)).toBeUndefined();
	});

	it('never resolves for a disabled account', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		h.db
			.prepare('UPDATE users SET is_active = 0, disabled_at = ? WHERE id = ?')
			.run(Date.now(), ayse.id);
		expect(resolveSession(h.db, session.token)).toBeNull();
	});

	it('slides the idle window at most once per hour (§5)', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		expect(resolveSession(h.db, session.token)?.slidIdleExpiresAt).toBeNull();

		h.db
			.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
			.run(Date.now() - 61 * 60_000, session.sessionId);
		const slid = resolveSession(h.db, session.token);
		expect(slid?.slidIdleExpiresAt).not.toBeNull();

		// And immediately again does not write.
		expect(resolveSession(h.db, session.token)?.slidIdleExpiresAt).toBeNull();
	});

	it('never slides the idle window past the absolute ceiling', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		const ceiling = Date.now() + 60_000;
		h.db
			.prepare(
				'UPDATE sessions SET last_seen_at = ?, absolute_expires_at = ? WHERE id = ?'
			)
			.run(Date.now() - 61 * 60_000, ceiling, session.sessionId);
		const slid = resolveSession(h.db, session.token);
		expect(slid?.slidIdleExpiresAt).toBe(ceiling);
	});
});

describe('destruction', () => {
	it('destroySessionById removes exactly one', () => {
		const a = createSession(h.db, ayse.id, 'password', null);
		const b = createSession(h.db, ayse.id, 'password', null);
		destroySessionById(h.db, a.sessionId);
		expect(resolveSession(h.db, a.token)).toBeNull();
		expect(resolveSession(h.db, b.token)).not.toBeNull();
	});

	it('destroyAllSessionsForUser removes that user only, and reports the ids', async () => {
		const other = await seedUser(h.db, { username: 'mehmet' });
		const a = createSession(h.db, ayse.id, 'password', null);
		const b = createSession(h.db, ayse.id, 'password', null);
		const theirs = createSession(h.db, other.id, 'password', null);

		const destroyed = destroyAllSessionsForUser(h.db, ayse.id);
		expect(destroyed.sort()).toEqual([a.sessionId, b.sessionId].sort());
		expect(resolveSession(h.db, a.token)).toBeNull();
		expect(resolveSession(h.db, theirs.token)).not.toBeNull();
	});

	it('destroyOtherSessions keeps the one it is told to keep (§3.2, D-004)', () => {
		const keep = createSession(h.db, ayse.id, 'password', null);
		const drop = createSession(h.db, ayse.id, 'password', null);
		expect(destroyOtherSessions(h.db, ayse.id, keep.sessionId)).toEqual([drop.sessionId]);
		expect(resolveSession(h.db, keep.token)).not.toBeNull();
		expect(resolveSession(h.db, drop.token)).toBeNull();
	});

	it('cascades when the user row goes', () => {
		const session = createSession(h.db, ayse.id, 'password', null);
		h.db.prepare('DELETE FROM users WHERE id = ?').run(ayse.id);
		expect(sessionRow(session.sessionId)).toBeUndefined();
	});
});

describe('reaping (§3.7)', () => {
	it('deletes rows past either expiry and leaves live ones', () => {
		const live = createSession(h.db, ayse.id, 'password', null);
		const idleGone = createSession(h.db, ayse.id, 'password', null);
		const absoluteGone = createSession(h.db, ayse.id, 'password', null);
		const past = Date.now() - 1;
		h.db.prepare('UPDATE sessions SET idle_expires_at = ? WHERE id = ?').run(past, idleGone.sessionId);
		h.db
			.prepare('UPDATE sessions SET created_at = ?, absolute_expires_at = ? WHERE id = ?')
			.run(past - 1000, past, absoluteGone.sessionId);

		expect(reapExpiredSessions(h.db)).toBe(2);
		expect(sessionRow(live.sessionId)).toBeDefined();
		expect(sessionRow(idleGone.sessionId)).toBeUndefined();
		expect(sessionRow(absoluteGone.sessionId)).toBeUndefined();
	});
});
