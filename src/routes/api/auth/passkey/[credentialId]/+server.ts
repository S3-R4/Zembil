/** `DELETE /api/auth/passkey/{credentialId}` — CONTRACT.md §3.2. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { handleAuth } from '$lib/server/auth/http';
import { requireSession } from '$lib/server/auth/guards';
import { deleteOwnPasskey } from '$lib/server/auth/users';
import { notFound } from '$lib/server/domain/errors';

export const DELETE: RequestHandler = async ({ locals, params }) =>
	handleAuth(() => {
		const user = requireSession(locals);
		// §3.2: one of the caller's OWN passkeys. The ownership predicate lives in
		// the DELETE statement itself, so somebody else's credential id is a 404
		// and not a deletion.
		if (!deleteOwnPasskey(getDb(), user.id, params.credentialId)) {
			throw notFound('PASSKEY_NOT_FOUND', 'Passkey not found.');
		}
		return new Response(null, { status: 204 });
	});
