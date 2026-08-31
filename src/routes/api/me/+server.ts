/** `GET /api/me` — CONTRACT.md §3.2. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { requireSession } from '$lib/server/auth/guards';
import { listPasskeys } from '$lib/server/auth/users';

export const GET: RequestHandler = async ({ locals }) =>
	handleAuth(() => {
		const user = requireSession(locals);
		// §3.2: the caller's OWN passkeys, ordered created_at ASC. Never another
		// user's, at any privilege level — so the id comes from the session, not
		// from a query parameter.
		return ok({ user, passkeys: listPasskeys(getDb(), user.id) });
	});
