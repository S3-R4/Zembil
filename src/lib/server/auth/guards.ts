/**
 * Route-level authorization — CONTRACT.md §3 ("Auth levels").
 *
 * `locals.user` is set by `hooks.server.ts` from the session cookie and from
 * nothing else. These read it; they never read the request body.
 */
import type { User } from '$lib/types';
import { DomainError } from '../domain/errors.js';

export function requireSession(locals: App.Locals): User {
	const user = locals.user;
	if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'Please sign in.');
	return user;
}

/**
 * Deliberately unreachable, and staying. `handle` never sets `locals.user`
 * without `locals.sessionId` — they are written together from one
 * `resolveSession` result — and every caller here runs `requireSession` first,
 * so an audit could replace the one call site with `locals.sessionId as string`
 * and leave the suite green. That is not a test to write: a test would only
 * assert the impossible input this rejects. It is a narrowing from
 * `string | null` to `string` that refuses to launder the null instead of
 * casting it away, and it costs one comparison.
 */
export function requireSessionId(locals: App.Locals): string {
	const sessionId = locals.sessionId;
	if (!sessionId) throw new DomainError('UNAUTHENTICATED', 401, 'Please sign in.');
	return sessionId;
}

/**
 * §3: "Every non-public endpoint is checked server-side on every request.
 * Rendering an admin page is not an authorization check."
 *
 * A non-admin gets `403 FORBIDDEN` rather than `404`: the admin routes are a
 * fixed, documented set, so hiding their existence buys nothing, and a 404
 * would be indistinguishable from a genuinely missing user id.
 */
export function requireAdmin(locals: App.Locals): User {
	const user = requireSession(locals);
	if (!user.isAdmin) {
		throw new DomainError('FORBIDDEN', 403, 'You do not have permission to do that.');
	}
	return user;
}
