/** `POST /api/auth/logout` — CONTRACT.md §3.2. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleAuth } from '$lib/server/auth/http';
import { revokeSession } from '$lib/server/realtime/bus';
import { destroySessionById } from '$lib/server/auth/session';
import { clearSessionCookie } from '$lib/server/auth/cookies';

export const POST: RequestHandler = async ({ locals, cookies }) =>
	handleAuth(() => {
		// Deliberately not `requireSession`: logging out with no session is the
		// state the caller asked for, and a 401 here would strand a client whose
		// session expired between page load and the tap.
		if (locals.sessionId) {
			destroySessionById(getDb(), locals.sessionId);
			revokeSession(locals.sessionId);
		}
		clearSessionCookie(cookies);
		return new Response(null, { status: 204 });
	});
