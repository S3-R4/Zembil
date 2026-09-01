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
 *
 * Matched against `event.route.id`, not the request path — see `createHandle`
 * for why. Every entry here is a static route, so its id and its path are the
 * same string.
 *
 * The public endpoints are listed too. §3.2 makes login public, and a flagged
 * session presenting itself at `/api/auth/login` was being told to change a
 * password before it could sign in. Exempting them is safe because the flag is
 * re-read from `users` on every request, so signing in again cannot clear it.
 */
export const PASSWORD_GATE_EXEMPT: ReadonlySet<string> = new Set([
	'/api/me',
	'/api/auth/password',
	'/api/auth/logout',
	'/api/auth/login',
	'/api/auth/passkey/login/options',
	'/api/auth/passkey/login/verify',
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
	// `authenticated` is computed from the INCOMING session, so the login
	// response — the one carrying the member's name and the Set-Cookie — was
	// leaving without `no-store`. A response that hands out a session is an
	// authenticated response by any reading that matters.
	if (authenticated || response.headers.has('set-cookie')) {
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
		//
		// Matched on `event.route.id`, NOT on `event.url.pathname`. SvelteKit
		// leaves `pathname` percent-encoded and routes on a decoded copy, so
		// `/%61pi/admin/users` does not start with `/api/` and still reaches the
		// admin endpoint. An audit confirmed that against the production build:
		// a bootstrapped admin who had never changed the password could read the
		// account list and create another admin through one encoded character.
		// `route.id` is the matched pattern, already canonical and already
		// decoded. It is null only when nothing matched, and then there is no
		// endpoint to protect — the path fallback keeps the shape of the check.
		const routeId = event.route?.id ?? path;
		if (
			authenticated &&
			event.locals.user?.mustChangePassword &&
			routeId.startsWith('/api/') &&
			!PASSWORD_GATE_EXEMPT.has(routeId)
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
