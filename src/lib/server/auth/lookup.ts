/**
 * Two re-exports that keep the routes from importing half of `users.ts` and
 * `password.ts` each. No logic of its own.
 */
export { toUser } from './users.js';
import { usernameKey } from './password.js';

/** §3.7: the login bucket is keyed by `username_key`, so `Ayse`, `ayse` and
 *  `AYSE` share one bucket rather than getting three. A non-string is keyed as
 *  the empty string, which still consumes a token — a malformed body must not
 *  be a free attempt. */
export function usernameKeyOf(value: unknown): string {
	return typeof value === 'string' ? usernameKey(value) : '';
}
