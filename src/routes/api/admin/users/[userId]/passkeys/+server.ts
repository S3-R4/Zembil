/** `DELETE /api/admin/users/{userId}/passkeys` — CONTRACT.md §3.3. Auth: admin. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { requireAdmin } from '$lib/server/auth/guards';
import { deleteAllPasskeys, requireUser } from '$lib/server/auth/users';

export const DELETE: RequestHandler = async ({ locals, params }) =>
	handleAuth(() => {
		requireAdmin(locals);
		const db = getDb();
		// A missing account is a 404 rather than a silent "removed 0" — the admin
		// screen would otherwise report success for a typo'd id.
		requireUser(db, params.userId);
		// §3.3: ALL of that user's passkeys. The recovery path for a lost phone.
		return ok({ removed: deleteAllPasskeys(db, params.userId) });
	});
