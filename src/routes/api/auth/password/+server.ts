/** `POST /api/auth/password` — CONTRACT.md §3.2, D-004. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { readJson } from '$lib/server/domain/responses';
import { revokeSession } from '$lib/server/realtime/bus';
import { handleAuth } from '$lib/server/auth/http';
import { requireSession, requireSessionId } from '$lib/server/auth/guards';
import { changeOwnPassword } from '$lib/server/auth/authenticate';
import {
	createSession,
	destroyOtherSessions,
	destroySessionById
} from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookies';

export const POST: RequestHandler = async ({ locals, request, cookies }) =>
	handleAuth(async () => {
		const user = requireSession(locals);
		const currentSessionId = requireSessionId(locals);
		const body = await readJson(request);
		const db = getDb();

		await changeOwnPassword(db, user.id, body.currentPassword, body.newPassword);

		// §3.2: "all other sessions for that user are destroyed while the current
		// one is rotated." The two halves are separate on purpose — the other
		// sessions get `session.revoked` and are torn down, the current one is
		// replaced with a fresh token so the member stays signed in on the device
		// they are holding.
		for (const sessionId of destroyOtherSessions(db, user.id, currentSessionId)) {
			revokeSession(sessionId);
		}

		destroySessionById(db, currentSessionId);
		const session = createSession(db, user.id, 'password', request.headers.get('user-agent'));
		setSessionCookie(cookies, session.token, session.idleExpiresAt);

		// The caller's own SSE stream is deliberately NOT revoked: `session.revoked`
		// means "you are signed out" to the client, and this member is not. The
		// stream outlives the session row it was opened under until the browser
		// reconnects, which it does on the next navigation; `revokeUserStreams`
		// still reaches it by user id, and the per-session cap in §4 bounds it.
		return new Response(null, { status: 204 });
	});
