/** `GET /api/push/key` — CONTRACT.md §8.7. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getConfig } from '$lib/server/auth/config';
import { requireSession } from '$lib/server/auth/guards';
import { handle, ok } from '$lib/server/domain/responses';
import { getVapidPublicKey, requirePushEnabled } from '$lib/server/push';

/**
 * The PUBLIC half only. The keypair is generated on first use (D-038), so this
 * request is what provisions it — there is nothing for an operator to create.
 * The private half is never returned by this or any other route, and a test in
 * `tests/push/` asserts that against every `/api/push/*` response body.
 */
export const GET: RequestHandler = async ({ locals }) =>
	handle(() => {
		requireSession(locals);
		requirePushEnabled(getConfig());
		return ok({ publicKey: getVapidPublicKey(getDb()) });
	});
