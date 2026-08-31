/**
 * The session cookie — CONTRACT.md §5.
 *
 * One module so the name and the attributes cannot drift apart between login,
 * logout, password change and the hooks' slide-forward refresh.
 */
import type { Cookies } from '@sveltejs/kit';
import { getConfig } from './config.js';

/**
 * §5: `__Host-zembil_session` over HTTPS, `zembil_session` over plain HTTP.
 *
 * The `__Host-` prefix is not cosmetic — a browser refuses to store such a
 * cookie unless it is `Secure`, `Path=/` and has no `Domain`. Over `http://`
 * (dev only) the `Secure` attribute cannot be honoured, so the prefixed name
 * would be silently dropped and login would fail with no error anywhere.
 */
export function cookieName(): string {
	return getConfig().originIsHttps ? '__Host-zembil_session' : 'zembil_session';
}

/**
 * `Secure` is written literally rather than left to SvelteKit's default, which
 * derives it from the request URL: behind a TLS-terminating reverse proxy the
 * app sees plain HTTP and would emit a non-Secure cookie under a `__Host-` name.
 */
function attributes(maxAgeSeconds: number) {
	const config = getConfig();
	return {
		path: '/' as const,
		httpOnly: true,
		secure: config.originIsHttps,
		sameSite: 'lax' as const,
		maxAge: maxAgeSeconds
	};
}

function maxAgeFor(idleExpiresAt: number): number {
	// Never negative: a browser reads `Max-Age=-1` as "delete now", which would
	// throw away a session that is still valid for a few more milliseconds.
	return Math.max(1, Math.ceil((idleExpiresAt - Date.now()) / 1000));
}

/** §5: `Max-Age` matches `idle_expires_at`. */
export function setSessionCookie(cookies: Cookies, token: string, idleExpiresAt: number): void {
	cookies.set(cookieName(), token, attributes(maxAgeFor(idleExpiresAt)));
}

/**
 * Re-sends the same token with a new `Max-Age`. Called when `resolveSession`
 * slid the idle window forward, so a browser that would have dropped the cookie
 * tomorrow keeps it for another full idle period.
 */
export function refreshSessionCookie(
	cookies: Cookies,
	token: string,
	idleExpiresAt: number
): void {
	setSessionCookie(cookies, token, idleExpiresAt);
}

export function readSessionCookie(cookies: Cookies): string | null {
	return cookies.get(cookieName()) ?? null;
}

export function clearSessionCookie(cookies: Cookies): void {
	// `delete` must repeat path/secure/httpOnly or the browser matches a
	// different cookie than the one that was set and leaves the real one alone.
	const config = getConfig();
	cookies.delete(cookieName(), {
		path: '/',
		httpOnly: true,
		secure: config.originIsHttps,
		sameSite: 'lax'
	});
}
