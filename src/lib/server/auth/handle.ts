/**
 * The request seam — CONTRACT.md §3 (origin check), §5 (cookies, security
 * headers), §3.2 (`must_change_password`).
 *
 * Separated from `src/hooks.server.ts` so it can be exercised against a
 * temporary database. `hooks.server.ts` performs the once-per-process startup
 * of §3.8 and then exports `createHandle(db, config)` as its `handle`; nothing
 * here reads `process.env` or touches the singleton connection.
 */
import type { Handle } from '@sveltejs/kit';
import type { Db } from '../db/index.js';
import { DomainError } from '../domain/errors.js';
import { errorResponse } from '../domain/responses.js';
import type { AuthConfig } from './config.js';
import { clearSessionCookie, readSessionCookie, refreshSessionCookie } from './cookies.js';
import { resolveSession } from './session.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** §3.8: the ONLY unauthenticated endpoint, and the only one exempt from the
 *  Origin check. */
export const HEALTH_PATH = '/api/health';

/**
 * §3.2: while `must_change_password` is set, every endpoint returns
 * `403 PASSWORD_CHANGE_REQUIRED` except these.
 *
 * The gate covers `/api/**` only. Non-API routes are the HTML shell, which
 * carries no family data and has to render for the change-password screen to
 * exist at all — blocking it would lock the member out of the one action that
 * clears the flag. Every route that returns data is under `/api/`.
 */
export const PASSWORD_GATE_EXEMPT: ReadonlySet<string> = new Set([
	'/api/me',
	'/api/auth/password',
	'/api/auth/logout',
	HEALTH_PATH
]);

/**
 * §5. `Content-Security-Policy` is produced by `kit.csp` in `svelte.config.js`
 * and by NOTHING else — setting it here would either replace the header
 * SvelteKit generates, losing its hydration-script hash, or add a second one, a
 * browser enforcing the intersection of the two, which loses the hash as well.
 * Either way the app renders, never hydrates, and does it in the production
 * build only.
 */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	['Referrer-Policy', 'same-origin'],
	['X-Content-Type-Options', 'nosniff'],
	['Cross-Origin-Opener-Policy', 'same-origin'],
	[
		'Permissions-Policy',
		'geolocation=(), camera=(), microphone=(), payment=(), ' +
			'publickey-credentials-get=(self), publickey-credentials-create=(self)'
	]
];

export function applySecurityHeaders(response: Response, authenticated: boolean): Response {
	for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
	if (authenticated) {
		// §5: EVERY response to an authenticated request, HTML and JSON alike. The
		// app ships a service worker, and a list carrying family members' names
		// must never reach a shared or intermediary cache.
		response.headers.set('Cache-Control', 'no-store');
	}
	return response;
}

export function createHandle(db: Db, config: AuthConfig): Handle {
	return async ({ event, resolve }) => {
		const path = event.url.pathname;
		const isHealth = path === HEALTH_PATH;

		// ---- Origin check (§3) ---------------------------------------------
		// Here, for every mutating method and every content type. This is the
		// control. SvelteKit's `kit.csrf.checkOrigin` stays enabled but inspects
		// only the three form content types and ignores `application/json`
		// entirely, so it covers none of this API.
		if (!isHealth && MUTATING.has(event.request.method)) {
			const origin = event.request.headers.get('origin');
			// A MISSING Origin is rejected, never allowed through.
			if (origin !== config.origin) {
				return applySecurityHeaders(
					errorResponse(
						new DomainError('ORIGIN_MISMATCH', 403, 'This request did not come from Zembil.')
					),
					false
				);
			}
		}

		// ---- Session resolution (§5) ---------------------------------------
		event.locals.user = null;
		event.locals.sessionId = null;

		if (!isHealth) {
			const token = readSessionCookie(event.cookies);
			if (token) {
				const resolved = resolveSession(db, token);
				if (resolved) {
					event.locals.user = resolved.user;
					event.locals.sessionId = resolved.sessionId;
					if (resolved.slidIdleExpiresAt !== null) {
						refreshSessionCookie(event.cookies, token, resolved.slidIdleExpiresAt);
					}
				} else {
					// Expired, unknown, or owned by a disabled account — one outcome for
					// all three, and the stale cookie goes so the browser stops sending it.
					clearSessionCookie(event.cookies);
				}
			}
		}

		const authenticated = event.locals.user !== null;

		// ---- must_change_password (§3.2) -----------------------------------
		// Enforced server-side, not by the client. Without this the temporary
		// password an admin hands out over a chat app stays valid for the full
		// 180-day absolute session TTL as soon as the member dismisses the prompt.
		if (
			authenticated &&
			event.locals.user?.mustChangePassword &&
			path.startsWith('/api/') &&
			!PASSWORD_GATE_EXEMPT.has(path)
		) {
			return applySecurityHeaders(
				errorResponse(
					new DomainError(
						'PASSWORD_CHANGE_REQUIRED',
						403,
						'Please change your password before continuing.'
					)
				),
				true
			);
		}

		return applySecurityHeaders(await resolve(event), authenticated);
	};
}
