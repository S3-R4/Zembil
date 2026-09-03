/**
 * The users repository and the admin operations — CONTRACT.md §1.1, §3.2, §3.3.
 *
 * Everything that reads or writes `users` lives here. Routes hold no SQL.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminUser, Locale, Passkey, Theme, User } from '$lib/types';
import { bool, fromBool, tx, type Db } from '../db/index.js';
import { DomainError, conflict, notFound } from '../domain/errors.js';
import { requiredText } from '../domain/validate.js';
import { DEFAULT_LOCALE, DEFAULT_THEME } from '$lib/types';
import { validateLocale } from './locale.js';
import { validateTheme } from './theme.js';
import { generateTemporaryPassword, hashPassword, usernameKey } from './password.js';

export interface UserRow {
	id: string;
	username: string;
	username_key: string;
	display_name: string;
	password_hash: string;
	is_admin: number;
	is_active: number;
	must_change_password: number;
	created_at: number;
	updated_at: number;
	disabled_at: number | null;
	locale: string;
	theme: string;
}

export function toUser(row: UserRow): User {
	return {
		id: row.id,
		username: row.username,
		displayName: row.display_name,
		isAdmin: fromBool(row.is_admin),
		isActive: fromBool(row.is_active),
		mustChangePassword: fromBool(row.must_change_password),
		createdAt: Number(row.created_at),
		// I-14 makes this one of the three by CHECK, so the fallback is not a
		// validator — it is what keeps a row written before migration 002 (or by
		// a future column default change) from producing `undefined` in a
		// response shape the client destructures.
		locale: (row.locale as Locale) ?? DEFAULT_LOCALE,
		// Same reasoning as `locale` above: migration 004's CHECK makes this one
		// of the eight, so the fallback is not a validator — it keeps a row read
		// through an older connection from producing `undefined` in a response
		// the client destructures.
		theme: (row.theme as Theme) ?? DEFAULT_THEME
	};
}

const SELECT_USER = `
  SELECT id, username, username_key, display_name, password_hash, is_admin, is_active,
         must_change_password, created_at, updated_at, disabled_at, locale, theme
    FROM users
`;

export function findByUsername(db: Db, username: string): UserRow | null {
	if (typeof username !== 'string') return null;
	const row = db
		.prepare(`${SELECT_USER} WHERE username_key = ?`)
		.get(usernameKey(username)) as unknown as UserRow | undefined;
	return row ?? null;
}

export function findById(db: Db, id: string): UserRow | null {
	const row = db.prepare(`${SELECT_USER} WHERE id = ?`).get(id) as unknown as UserRow | undefined;
	return row ?? null;
}

export function requireUser(db: Db, id: string): UserRow {
	const row = findById(db, id);
	if (!row) throw notFound('USER_NOT_FOUND', 'Account not found.');
	return row;
}

/** §1.1: 32 random bytes, stable for the life of the account. */
export function newUserHandle(): Uint8Array {
	return randomBytes(32);
}

/** §1.1: the 32-byte handle, read separately because it is never part of a
 *  `User` and must not travel with one by accident. */
export function userHandle(db: Db, userId: string): Uint8Array<ArrayBuffer> {
	const row = db
		.prepare('SELECT webauthn_user_handle FROM users WHERE id = ?')
		.get(userId) as unknown as { webauthn_user_handle: Uint8Array<ArrayBuffer> } | undefined;
	if (!row) throw notFound('USER_NOT_FOUND', 'Account not found.');
	return row.webauthn_user_handle;
}

// --------------------------------------------------------------------------
// Passkeys
// --------------------------------------------------------------------------

interface CredentialRow {
	id: string;
	device_label: string;
	created_at: number;
	last_used_at: number | null;
	backed_up: number;
}

/** §3.2: the caller's OWN passkeys, `created_at ASC`. Never another user's. */
export function listPasskeys(db: Db, userId: string): Passkey[] {
	const rows = db
		.prepare(
			`SELECT id, device_label, created_at, last_used_at, backed_up
			   FROM credentials WHERE user_id = ? ORDER BY created_at ASC, id ASC`
		)
		.all(userId) as unknown as CredentialRow[];
	return rows.map((row) => ({
		id: row.id,
		deviceLabel: row.device_label,
		createdAt: Number(row.created_at),
		lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
		backedUp: fromBool(row.backed_up)
	}));
}

/**
 * §3.2: removes one of the caller's OWN passkeys. The `user_id` predicate is in
 * the DELETE itself, not in a prior read — a check-then-delete would let a
 * caller who guessed another member's credential id remove it in the window
 * between the two statements, and there is no reason to leave that open.
 */
export function deleteOwnPasskey(db: Db, userId: string, credentialId: string): boolean {
	const result = db
		.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?')
		.run(credentialId, userId);
	return Number(result.changes) > 0;
}

/** §3.3: an admin removes ALL of a user's passkeys. Returns how many went. */
export function deleteAllPasskeys(db: Db, userId: string): number {
	const result = db.prepare('DELETE FROM credentials WHERE user_id = ?').run(userId);
	return Number(result.changes);
}

// --------------------------------------------------------------------------
// Admin listing
// --------------------------------------------------------------------------

interface AdminUserRow extends UserRow {
	passkey_count: number;
	last_seen_at: number | null;
}

export function listUsers(db: Db): AdminUser[] {
	const rows = db
		.prepare(
			`SELECT u.id, u.username, u.username_key, u.display_name, u.password_hash, u.is_admin,
			        u.is_active, u.must_change_password, u.created_at, u.updated_at, u.disabled_at, u.locale,
			        u.theme,
			        (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkey_count,
			        (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
			   FROM users u
			  ORDER BY u.is_active DESC, u.username_key ASC`
		)
		.all() as unknown as AdminUserRow[];
	return rows.map((row) => ({
		...toUser(row),
		passkeyCount: Number(row.passkey_count),
		disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
		lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at)
	}));
}

// --------------------------------------------------------------------------
// Admin mutations
// --------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

/** §3.2: minimum 12 characters, maximum 256, no other composition rules. */
export function validatePassword(value: unknown): string {
	if (typeof value !== 'string') {
		throw new DomainError('VALIDATION_FAILED', 400, 'Password must be text.');
	}
	// NOT trimmed: a password is a byte sequence, and silently altering it means
	// the value that was hashed is not the value the member typed.
	if (value.length < MIN_PASSWORD_LENGTH) {
		throw new DomainError(
			'VALIDATION_FAILED',
			400,
			`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
		);
	}
	if (value.length > MAX_PASSWORD_LENGTH) {
		throw new DomainError(
			'VALIDATION_FAILED',
			400,
			`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`
		);
	}
	return value;
}

/**
 * §3.1a: `trim; 1–32; [a-z0-9._-]+ after lowercasing`. The charset half of that
 * rule was not enforced — any Unicode string was accepted. That is not an auth
 * hole (`usernameKey` NFKC-normalizes and lowercases identically at creation
 * and at lookup, and `users.username_key` is UNIQUE, so two spellings cannot
 * land on one account) but it is drift, and it is the kind that becomes a hole
 * later: a username is what an admin reads back to a member over the phone, and
 * a right-to-left override or a Cyrillic 'а' makes two accounts indisplayable
 * from each other.
 *
 * Checked against the LOWERCASED form, as the contract says, so `Ayse` is
 * accepted and stored as typed while `username_key` stays in the charset.
 */
const USERNAME_CHARSET = /^[a-z0-9._-]+$/;

export const validateUsername = (value: unknown) => {
	const trimmed = requiredText(value, 'Username', 32);
	if (!USERNAME_CHARSET.test(usernameKey(trimmed))) {
		throw new DomainError(
			'VALIDATION_FAILED',
			400,
			'Username can use only letters, digits, dots, dashes and underscores.'
		);
	}
	return trimmed;
};
export const validateDisplayName = (value: unknown) => requiredText(value, 'Display name', 60);

export function countActiveAdmins(db: Db): number {
	const row = db
		.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_active = 1')
		.get() as unknown as { n: number };
	return Number(row.n);
}

/**
 * §3.3: "the system must never reach zero active admins." Called INSIDE the
 * transaction, after the write, so the check sees the post-write state and a
 * failure rolls the write back.
 *
 * With `CANNOT_DISABLE_SELF` and `CANNOT_DEMOTE_SELF` in place this is not
 * reachable through the HTTP API — the acting admin is itself active and admin,
 * so the count cannot fall to zero unless the actor targets itself, which those
 * two guards already refuse. It is kept as the invariant's own enforcement:
 * the self-guards protect a specific path, this protects the property, and a
 * future endpoint (account deletion is in BACKLOG.md) would need it. The test
 * for it calls it directly, because nothing else can.
 */
export function assertAdminsRemain(db: Db): void {
	if (countActiveAdmins(db) === 0) {
		throw conflict('LAST_ADMIN', 'There must always be at least one active admin.');
	}
}

export interface CreateUserInput {
	username: unknown;
	displayName: unknown;
	isAdmin: unknown;
	/**
	 * §8.5: the account's INITIAL interface language, negotiated by the route
	 * from the creating request's `Accept-Language`. Omitted means
	 * `DEFAULT_LOCALE` — which is what `runBootstrap` gets, since it has no
	 * request to negotiate against.
	 */
	locale?: Locale;
}

export interface CreatedUser {
	user: User;
	temporaryPassword: string;
}

/**
 * §3.3. The server generates the password, returns it once, never stores it in
 * plaintext, and sets `must_change_password=1`.
 *
 * Hashing happens before the transaction opens: scrypt at N=65536 takes tens of
 * milliseconds, and `node:sqlite` is synchronous on the single connection every
 * other request shares. Awaiting inside `tx()` would hold the write lock across
 * an await point.
 */
export async function createUser(db: Db, input: CreateUserInput): Promise<CreatedUser> {
	const username = validateUsername(input.username);
	const displayName = validateDisplayName(input.displayName);
	if (typeof input.isAdmin !== 'boolean') {
		throw new DomainError('VALIDATION_FAILED', 400, 'isAdmin must be true or false.');
	}
	// Captured before the await below: TypeScript drops the narrowing of a
	// property access across the closure that `tx()` takes.
	const isAdmin: boolean = input.isAdmin;
	// Validated even though the route negotiated it: `createUser` is also called
	// from tests and scripts, and an unchecked value here would be a 500 from the
	// I-14 CHECK rather than a 400.
	const locale: Locale = input.locale === undefined ? DEFAULT_LOCALE : validateLocale(input.locale);
	const key = usernameKey(username);
	const temporaryPassword = generateTemporaryPassword();
	const passwordHash = await hashPassword(temporaryPassword);
	const id = randomUUID();
	const ts = Date.now();

	const user = tx(db, () => {
		const existing = db.prepare('SELECT id FROM users WHERE username_key = ?').get(key);
		if (existing) throw conflict('USERNAME_TAKEN', 'That username is already taken.');
		db.prepare(
			`INSERT INTO users (id, username, username_key, display_name, password_hash, is_admin,
			                    is_active, must_change_password, webauthn_user_handle,
			                    created_at, updated_at, disabled_at, locale)
			 VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, NULL, ?)`
		).run(
			id,
			username,
			key,
			displayName,
			passwordHash,
			bool(isAdmin),
			newUserHandle(),
			ts,
			ts,
			locale
		);
		return toUser(requireUser(db, id));
	});

	return { user, temporaryPassword };
}

/**
 * §8.5: `PATCH /api/me`. The id is the caller's own, taken from the session by
 * the route; there is no parameter here or anywhere above it that names another
 * user, at any privilege level. Bumps nothing and emits nothing (§8.9).
 */
export function setLocale(db: Db, userId: string, locale: Locale): User {
	db.prepare('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?').run(
		locale,
		Date.now(),
		userId
	);
	return toUser(requireUser(db, userId));
}

/**
 * `PATCH /api/me`, the theme half. Same contract as `setLocale`: the id is the
 * caller's own, taken from the session by the route, and there is no parameter
 * anywhere above this that names another user.
 *
 * It bumps nothing and emits nothing — no shopping state changed, and the only
 * client that cares is the one that made the request. Unlike `locale`, the
 * server never composes anything from this column; it exists so the value can
 * reach `<html data-theme>` during SSR and so a second device agrees with the
 * first.
 */
export function setTheme(db: Db, userId: string, theme: Theme): User {
	db.prepare('UPDATE users SET theme = ?, updated_at = ? WHERE id = ?').run(
		theme,
		Date.now(),
		userId
	);
	return toUser(requireUser(db, userId));
}

/** Both at once, in one statement and one `updated_at`, for a PATCH that
 *  carries both. Two `UPDATE`s would be two rows' worth of work and two
 *  timestamps for what the caller sent as one change. */
export function setPreferences(
	db: Db,
	userId: string,
	prefs: { locale?: Locale; theme?: Theme }
): User {
	const sets: string[] = [];
	const values: Array<string | number> = [];
	if (prefs.locale !== undefined) {
		sets.push('locale = ?');
		values.push(validateLocale(prefs.locale));
	}
	if (prefs.theme !== undefined) {
		sets.push('theme = ?');
		values.push(validateTheme(prefs.theme));
	}
	if (sets.length === 0) {
		throw new DomainError('VALIDATION_FAILED', 400, 'Nothing to update.');
	}
	// The column names are literals from the two branches above and never from
	// the caller; every VALUE is bound. This is the same shape `patchUser` uses.
	db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
		...values,
		Date.now(),
		userId
	);
	return toUser(requireUser(db, userId));
}

export interface PatchUserInput {
	displayName?: unknown;
	isAdmin?: unknown;
	isActive?: unknown;
}

export interface PatchResult {
	user: User;
	/** True when the account was just disabled — the caller destroys its
	 *  sessions and terminates its streams. */
	revoked: boolean;
}

/**
 * §3.3. Guards, each `409`: `CANNOT_DISABLE_SELF`, `CANNOT_DEMOTE_SELF`,
 * `LAST_ADMIN`.
 */
export function patchUser(
	db: Db,
	targetId: string,
	patch: PatchUserInput,
	actorId: string
): PatchResult {
	const hasDisplayName = patch.displayName !== undefined;
	const hasIsAdmin = patch.isAdmin !== undefined;
	const hasIsActive = patch.isActive !== undefined;
	if (!hasDisplayName && !hasIsAdmin && !hasIsActive) {
		throw new DomainError('VALIDATION_FAILED', 400, 'Nothing to update.');
	}

	const displayName = hasDisplayName ? validateDisplayName(patch.displayName) : null;
	if (hasIsAdmin && typeof patch.isAdmin !== 'boolean') {
		throw new DomainError('VALIDATION_FAILED', 400, 'isAdmin must be true or false.');
	}
	if (hasIsActive && typeof patch.isActive !== 'boolean') {
		throw new DomainError('VALIDATION_FAILED', 400, 'isActive must be true or false.');
	}
	const nextIsAdmin = patch.isAdmin as boolean | undefined;
	const nextIsActive = patch.isActive as boolean | undefined;

	return tx(db, () => {
		const row = requireUser(db, targetId);
		const wasActive = fromBool(row.is_active);

		if (targetId === actorId && nextIsActive === false) {
			throw conflict('CANNOT_DISABLE_SELF', 'You cannot disable your own account.');
		}
		if (targetId === actorId && nextIsAdmin === false) {
			throw conflict('CANNOT_DEMOTE_SELF', 'You cannot remove your own admin rights.');
		}

		const ts = Date.now();
		if (hasDisplayName) {
			db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(
				displayName,
				ts,
				targetId
			);
		}
		if (hasIsAdmin) {
			db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?').run(
				bool(nextIsAdmin as boolean),
				ts,
				targetId
			);
		}
		if (hasIsActive) {
			// §3.3: `is_active` and `disabled_at` move in ONE statement. The DDL's
			// `CHECK ((is_active = 0) = (disabled_at IS NOT NULL))` aborts on any
			// write that sets one without the other, so a two-statement version
			// turns the Enable button into a 500.
			db.prepare(
				'UPDATE users SET is_active = ?, disabled_at = ?, updated_at = ? WHERE id = ?'
			).run(bool(nextIsActive as boolean), nextIsActive ? null : ts, ts, targetId);
		}

		assertAdminsRemain(db);

		const updated = toUser(requireUser(db, targetId));
		return { user: updated, revoked: wasActive && nextIsActive === false };
	});
}

/** §3.3: a new temporary password, `must_change_password=1`, all sessions gone. */
export async function resetUserPassword(db: Db, targetId: string): Promise<string> {
	// Reads before hashing so a missing account is a 404 rather than 60ms of
	// wasted scrypt followed by a 404.
	requireUser(db, targetId);
	const temporaryPassword = generateTemporaryPassword();
	const passwordHash = await hashPassword(temporaryPassword);
	const ts = Date.now();
	tx(db, () => {
		requireUser(db, targetId);
		db.prepare(
			'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?'
		).run(passwordHash, ts, targetId);
	});
	return temporaryPassword;
}

/** §3.2: a successful password change clears `must_change_password`. */
export function writePassword(db: Db, userId: string, passwordHash: string): void {
	db.prepare(
		'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?'
	).run(passwordHash, Date.now(), userId);
}

/** §1.3: transparent rehash on login when the stored parameters are weaker. */
export function writePasswordHashOnly(db: Db, userId: string, passwordHash: string): void {
	db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

// --------------------------------------------------------------------------
// Bootstrap — CONTRACT.md §3.8 and §6
// --------------------------------------------------------------------------

export interface BootstrapResult {
	created: boolean;
	username?: string;
	/** Present only when the password was generated rather than supplied. */
	generatedPassword?: string;
}

/**
 * §6: idempotent — acts only when `SELECT COUNT(*) FROM users` returns zero. A
 * restart with the env vars still set never resets an existing admin's password.
 */
export async function bootstrapFirstAdmin(
	db: Db,
	options: { username: string; password: string | null }
): Promise<BootstrapResult> {
	// TWO checks, deliberately, and they are not duplicates. This one is the
	// cheap exit: it keeps a restart from paying for a scrypt (tens of
	// milliseconds, before the server listens) that it will then throw away. The
	// one inside the transaction below is the actual guard. Breaking this one
	// alone leaves behaviour correct and startup slower, which is why the test
	// for it asserts the cost rather than the outcome.
	const count = db.prepare('SELECT COUNT(*) AS n FROM users').get() as unknown as { n: number };
	if (Number(count.n) > 0) return { created: false };

	const username = validateUsername(options.username);
	const generated = options.password === null;
	const password = generated ? generateTemporaryPassword() : validatePassword(options.password);
	const passwordHash = await hashPassword(password);
	const id = randomUUID();
	const ts = Date.now();

	const created = tx(db, () => {
		// Re-checked inside the transaction: the count above was read outside it.
		const inner = db.prepare('SELECT COUNT(*) AS n FROM users').get() as unknown as { n: number };
		if (Number(inner.n) > 0) return false;
		db.prepare(
			`INSERT INTO users (id, username, username_key, display_name, password_hash, is_admin,
			                    is_active, must_change_password, webauthn_user_handle,
			                    created_at, updated_at, disabled_at)
			 VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, NULL)`
		).run(
			id,
			username,
			usernameKey(username),
			username,
			passwordHash,
			newUserHandle(),
			ts,
			ts
		);
		return true;
	});

	if (!created) return { created: false };
	// §3.8: `must_change_password` is set above whether or not the password was
	// generated. A password handed to an operator through an env var or a log
	// line is a handoff credential, not a standing one.
	return generated ? { created: true, username, generatedPassword: password } : { created: true, username };
}
