/** `POST /api/auth/passkey/register/verify` — CONTRACT.md §3.2. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { requireSession } from '$lib/server/auth/guards';
import {
	consumeChallenge,
	insertCredential,
	invalidCredentials,
	passkeyLabel,
	verifyRegistration
} from '$lib/server/auth/webauthn';
import { listPasskeys } from '$lib/server/auth/users';

export const POST: RequestHandler = async ({ locals, request }) =>
	handleAuth(async () => {
		const user = requireSession(locals);
		const body = await readJson(request);
		const db = getDb();

		const label = passkeyLabel(body.label);
		const { challenge, userId } = consumeChallenge(db, body.challengeId, 'registration');
		// The challenge was issued to a specific account. Accepting one issued to
		// somebody else would let a member attach their authenticator to another
		// family member's account.
		if (userId !== user.id) throw invalidCredentials();

		const credential = await verifyRegistration(body.response, challenge);
		insertCredential(db, user.id, credential, label);

		const passkey = listPasskeys(db, user.id).find((p) => p.id === credential.id);
		if (!passkey) throw invalidCredentials();
		return ok({ passkey }, 201);
	});
