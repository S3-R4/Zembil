/** `POST /api/auth/login` — CONTRACT.md §3.2, §3.7. Auth: public. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { revokeSession } from '$lib/server/realtime/bus';
import { handleAuth, requestIp } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import { authenticatePassword } from '$lib/server/auth/authenticate';
import { createSession, destroySessionById } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookies';
import { toUser, usernameKeyOf } from '$lib/server/auth/lookup';

export const POST: RequestHandler = async (event) =>
	handleAuth(async () => {
		const { request, cookies, locals } = event;
		const body = await readJson(request);
		const db = getDb();

		// §3.7: both buckets are checked, independently. The per-IP one is a
		// coarse brake on a bot — the whole family shares one home WAN IP, so a
		// tight limit there would let one member's bad morning lock out everyone.
		// The per-username bucket is the real credential-stuffing control.
		enforce(limiters.loginByIp, requestIp(event));
		// Keyed by `username_key`, not the raw string: otherwise `Ayse`, `ayse`
		// and `AYSE` are three independent buckets on one account.
		enforce(limiters.loginByUsername, usernameKeyOf(body.username));

		const row = await authenticatePassword(db, body.username, body.password);

		// §5: the token is ROTATED on login. An existing session for this browser
		// is destroyed rather than left behind as a second live credential.
		if (locals.sessionId) {
			destroySessionById(db, locals.sessionId);
			revokeSession(locals.sessionId);
		}

		const session = createSession(db, row.id, 'password', request.headers.get('user-agent'));
		setSessionCookie(cookies, session.token, session.idleExpiresAt);

		const user = toUser(row);
		return ok({ user, mustChangePassword: user.mustChangePassword });
	});
