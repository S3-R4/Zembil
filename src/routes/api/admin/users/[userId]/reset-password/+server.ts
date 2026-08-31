/** `POST /api/admin/users/{userId}/reset-password` — CONTRACT.md §3.3, §3.0. Auth: admin. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok } from '$lib/server/domain/responses';
import { revokeUserStreams } from '$lib/server/realtime/bus';
import { handleAuth } from '$lib/server/auth/http';
import { requireAdmin } from '$lib/server/auth/guards';
import { resetUserPassword } from '$lib/server/auth/users';
import { destroyAllSessionsForUser } from '$lib/server/auth/session';

export const POST: RequestHandler = async ({ locals, params }) =>
	handleAuth(async () => {
		requireAdmin(locals);
		const db = getDb();
		const temporaryPassword = await resetUserPassword(db, params.userId);
		// §3.3: every session for that user is destroyed. Otherwise a reset issued
		// because a device was lost leaves the session on that device alive.
		destroyAllSessionsForUser(db, params.userId);
		revokeUserStreams(params.userId);
		return ok({ temporaryPassword });
	});
