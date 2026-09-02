/** `GET|POST /api/admin/users` — CONTRACT.md §3.3, §3.7. Auth: admin. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import { requireAdmin } from '$lib/server/auth/guards';
import { createUser, listUsers } from '$lib/server/auth/users';
import { negotiateAcceptLanguage } from '$lib/server/auth/locale';

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
			isAdmin: body.isAdmin,
			// §8.5: the ONE moment a header decides a locale. The admin creating
			// the account is usually sitting next to the person it is for, so their
			// browser's language is the best first guess available; the member
			// changes it with `PATCH /api/me` and the column wins from then on.
			locale: negotiateAcceptLanguage(request.headers.get('accept-language'))
		});
		return ok(created, 201);
	});
