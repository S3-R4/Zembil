/** `POST /api/auth/passkey/login/verify` — CONTRACT.md §3.2, §3.7. Auth: public. */
import type { RequestHandler } from './$types';
import { getDb, tx } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { revokeSession } from '$lib/server/realtime/bus';
import { handleAuth, requestIp } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import {
	consumeChallenge,
	invalidCredentials,
	recordAssertion,
	verifyAssertion
} from '$lib/server/auth/webauthn';
import { createSession, destroySessionById } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookies';
import { findById, toUser } from '$lib/server/auth/users';

export const POST: RequestHandler = async (event) =>
	handleAuth(async () => {
		const { request, cookies, locals } = event;
		enforce(limiters.passkeyAssertionByIp, requestIp(event));

		const body = await readJson(request);
		const db = getDb();

		// Deleted on FIRST use, success or failure — see `consumeChallenge`.
		const { challenge } = consumeChallenge(db, body.challengeId, 'authentication');
		const assertion = await verifyAssertion(db, body.response, challenge);

		const row = findById(db, assertion.userId);
		// §3.2: a disabled owner is the same `401 INVALID_CREDENTIALS` as an
		// unknown credential or a bad signature.
		if (!row || row.is_active !== 1) throw invalidCredentials();

		if (locals.sessionId) {
			destroySessionById(db, locals.sessionId);
			revokeSession(locals.sessionId);
		}

		// §3.2: "In the same transaction that creates the session,
		// passkey/login/verify updates the credential's counter and sets
		// last_used_at." Without the counter write the clone check compares every
		// future assertion against a permanently-zero stored value and can never
		// fire.
		const session = tx(db, () => {
			recordAssertion(db, assertion.credentialId, assertion.newCounter);
			return createSession(db, row.id, 'passkey', request.headers.get('user-agent'));
		});
		setSessionCookie(cookies, session.token, session.idleExpiresAt);

		return ok({ user: toUser(row) });
	});
