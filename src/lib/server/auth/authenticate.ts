/**
 * Password login and password change — CONTRACT.md §3.2.
 *
 * Kept out of the routes so the timing property below is testable without an
 * HTTP layer in the way.
 */
import type { Db } from '../db/index.js';
import { DomainError } from '../domain/errors.js';
import {
	dummyVerify,
	hashPassword,
	needsRehash,
	verifyPassword
} from './password.js';
import {
	findByUsername,
	validatePassword,
	writePassword,
	writePasswordHashOnly,
	type UserRow
} from './users.js';

/** §3.2: wrong username, wrong password and disabled account are ONE code, one
 *  message, one response shape. */
export function invalidCredentials(): DomainError {
	return new DomainError('INVALID_CREDENTIALS', 401, 'Those sign-in details are not valid.');
}

/**
 * §3.2: "the same amount of work done in all three cases."
 *
 * The three failure paths are deliberately shaped alike:
 *   - unknown username → `dummyVerify` runs a full scrypt at the same cost
 *   - wrong password   → a real scrypt that fails
 *   - disabled account → a real scrypt that SUCCEEDS, and is then discarded
 *
 * The disabled case is the one that is easy to get wrong. Returning early on
 * `is_active = 0` before verifying skips the scrypt entirely, and the resulting
 * few-tens-of-milliseconds gap tells any visitor which usernames exist and are
 * suspended — the exact distinction the shared error code exists to hide.
 */
export async function authenticatePassword(
	db: Db,
	username: unknown,
	password: unknown
): Promise<UserRow> {
	if (typeof username !== 'string' || typeof password !== 'string') {
		// Still pays the scrypt cost: a malformed body must not be the fast path
		// that reveals the shape of the slow one.
		await dummyVerify(typeof password === 'string' ? password : '');
		throw invalidCredentials();
	}

	const row = findByUsername(db, username);
	if (!row) {
		await dummyVerify(password);
		throw invalidCredentials();
	}

	const matches = await verifyPassword(password, row.password_hash);
	if (!matches) throw invalidCredentials();
	if (row.is_active !== 1) throw invalidCredentials();

	// §1.3: transparent rehash when the stored parameters are weaker than target.
	if (needsRehash(row.password_hash)) {
		writePasswordHashOnly(db, row.id, await hashPassword(password));
	}

	return row;
}

/** §3.2: `401 INVALID_CREDENTIALS` if `currentPassword` is wrong; the new
 *  password clears `must_change_password`. */
export async function changeOwnPassword(
	db: Db,
	userId: string,
	currentPassword: unknown,
	newPassword: unknown
): Promise<void> {
	const row = db
		.prepare('SELECT id, password_hash FROM users WHERE id = ?')
		.get(userId) as unknown as { id: string; password_hash: string } | undefined;
	if (!row) throw invalidCredentials();

	if (typeof currentPassword !== 'string') {
		throw new DomainError('VALIDATION_FAILED', 400, 'Current password must be text.');
	}
	// The new password is validated BEFORE the current one is checked, so a
	// member who typed a too-short new password is told that rather than being
	// told their current password is wrong when it is not.
	const next = validatePassword(newPassword);

	if (!(await verifyPassword(currentPassword, row.password_hash))) throw invalidCredentials();

	writePassword(db, userId, await hashPassword(next));
}
