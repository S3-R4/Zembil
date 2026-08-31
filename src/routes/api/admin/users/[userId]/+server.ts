/** `PATCH /api/admin/users/{userId}` — CONTRACT.md §3.3, §3.0. Auth: admin. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { revokeUserStreams } from '$lib/server/realtime/bus';
import { handleAuth } from '$lib/server/auth/http';
import { requireAdmin } from '$lib/server/auth/guards';
import { patchUser } from '$lib/server/auth/users';
import { destroyAllSessionsForUser } from '$lib/server/auth/session';

export const PATCH: RequestHandler = async ({ locals, request, params }) =>
	handleAuth(async () => {
		const actor = requireAdmin(locals);
		const body = await readJson(request);
		const db = getDb();

		const result = patchUser(
			db,
			params.userId,
			{ displayName: body.displayName, isAdmin: body.isAdmin, isActive: body.isActive },
			actor.id
		);

		// §3.3 / §3.0: disabling destroys every session and terminates every open
		// SSE stream for that user immediately. Both happen AFTER the transaction
		// commits, so a rolled-back patch never signs anybody out.
		if (result.revoked) {
			destroyAllSessionsForUser(db, params.userId);
			revokeUserStreams(params.userId);
		}

		return ok({ user: result.user });
	});
