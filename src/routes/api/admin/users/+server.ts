/** `GET|POST /api/admin/users` — CONTRACT.md §3.3, §3.7. Auth: admin. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import { requireAdmin } from '$lib/server/auth/guards';
import { createUser, listUsers } from '$lib/server/auth/users';

export const GET: RequestHandler = async ({ locals }) =>
	handleAuth(() => {
		requireAdmin(locals);
		return ok({ users: listUsers(getDb()) });
	});

export const POST: RequestHandler = async ({ locals, request }) =>
	handleAuth(async () => {
		const actor = requireAdmin(locals);
		// §3.7: keyed by the acting `user_id`, 20 per hour.
		enforce(limiters.adminUserCreateByActor, actor.id);
		const body = await readJson(request);
		// §3.3: the server generates the password, returns it ONCE, never stores
		// it in plaintext, and sets must_change_password=1.
		const created = await createUser(getDb(), {
			username: body.username,
			displayName: body.displayName,
			isAdmin: body.isAdmin
		});
		return ok(created, 201);
	});
