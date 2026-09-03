/** `GET|PATCH /api/me` — CONTRACT.md §3.2, §8.5. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok, readJson } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { requireSession } from '$lib/server/auth/guards';
import { validateLocale } from '$lib/server/auth/locale';
import { validateTheme } from '$lib/server/auth/theme';
import { listPasskeys, setPreferences } from '$lib/server/auth/users';

export const GET: RequestHandler = async ({ locals }) =>
	handleAuth(() => {
		const user = requireSession(locals);
		// §3.2: the caller's OWN passkeys, ordered created_at ASC. Never another
		// user's, at any privilege level — so the id comes from the session, not
		// from a query parameter.
		return ok({ user, passkeys: listPasskeys(getDb(), user.id) });
	});

/**
 * §8.5: sets the caller's own interface preferences — `{ locale }`, `{ theme }`
 * or both. Anything else in the body is ignored, and there is deliberately no
 * parameter naming a user — not in the path, not in the body, not for an admin.
 * §3 forbids user ids on the wire for non-admins, so an endpoint that accepted
 * one would be an id oracle as well as a privilege question.
 *
 * §8.9: bumps nothing, emits nothing. No shopping state changed and the only
 * client that cares is the one that made the request.
 *
 * This shares a route id with `GET /api/me`, so it inherits that entry in
 * `PASSWORD_GATE_EXEMPT`. That is intended: a member who must change their
 * password has to be able to read the change-password screen, which means being
 * able to pick the language it renders in. The endpoint touches one column that
 * is not a credential and not an authorization input.
 */
export const PATCH: RequestHandler = async ({ locals, request }) =>
	handleAuth(async () => {
		const user = requireSession(locals);
		const body = await readJson(request);
		// PRESENT, not truthy: `{ locale: null }` is a caller trying to set a
		// locale to something invalid and must be a 400, while an omitted key is
		// simply not part of this patch. An empty body sets nothing and is a 400
		// from `setPreferences` — the same answer it gave before `theme` existed.
		const has = (k: string) => Object.hasOwn(body, k) && body[k] !== undefined;
		const prefs = {
			locale: has('locale') ? validateLocale(body.locale) : undefined,
			theme: has('theme') ? validateTheme(body.theme) : undefined
		};
		return ok({ user: setPreferences(getDb(), user.id, prefs) });
	});
