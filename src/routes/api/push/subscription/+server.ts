/** `GET|POST|DELETE /api/push/subscription` — CONTRACT.md §8.7. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getConfig } from '$lib/server/auth/config';
import { requireSession } from '$lib/server/auth/guards';
import { handle, ok, readJson } from '$lib/server/domain/responses';
import { handleAuth } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import {
	deleteSubscription,
	requirePushEnabled,
	subscriptionStatus,
	upsertSubscription,
	validateEndpoint,
	validateSubscriptionInput
} from '$lib/server/push';

/**
 * §8.7: `{ subscribed, deviceCount }`, **both scoped to the caller**. The
 * `endpoint` query parameter asks "is THIS browser registered to me?" — it is
 * never a lookup across the table, or it would answer "is this endpoint
 * registered to anyone?", which is the probe §8.7's DELETE semantics exist to
 * prevent. An absent parameter is `subscribed: false`, not an error: the client
 * legitimately calls this before it has a subscription at all.
 */
export const GET: RequestHandler = async ({ locals, url }) =>
	handle(() => {
		const user = requireSession(locals);
		requirePushEnabled(getConfig());
		const endpoint = url.searchParams.get('endpoint');
		return ok(subscriptionStatus(getDb(), user.id, endpoint));
	});

/**
 * §8.7: `201` on a new row, `200` when the endpoint was already registered —
 * including when it was registered to somebody ELSE, in which case the row
 * MOVES to the caller (I-17). It was already registered, so it is a `200`.
 */
// `handleAuth`, not `handle`: this is now the only non-auth route that can
// raise a §3.7 `429`, and the `Retry-After` header cannot ride in the error
// envelope (§3.1 permits exactly three sibling fields and this is not one).
export const POST: RequestHandler = async ({ locals, request }) =>
	handleAuth(async () => {
		const user = requireSession(locals);
		requirePushEnabled(getConfig());
		// §8.7: keyed by the ACTOR, not the IP. The row cap in
		// `upsertSubscription` is the bound that matters; this stops one member
		// walking up to it in a loop, and it is the only write in the app whose
		// row identity is a URL the caller chose.
		enforce(limiters.pushSubscribeByActor, user.id);
		const body = await readJson(request);
		const input = validateSubscriptionInput(body, request.headers.get('user-agent'));
		const result = upsertSubscription(getDb(), user.id, input);
		return ok({ subscribed: true, created: result.created }, result.created ? 201 : 200);
	});

/**
 * §8.7: idempotent, and a `200` whether or not anything was deleted. Deleting
 * an endpoint that belongs to another member deletes nothing and reports the
 * same `200` as deleting your own — telling the two apart would let a member
 * probe for another member's devices.
 */
export const DELETE: RequestHandler = async ({ locals, request }) =>
	handle(async () => {
		const user = requireSession(locals);
		requirePushEnabled(getConfig());
		const body = await readJson(request);
		// Validated even though it is only ever compared, never dereferenced:
		// §3.1a is "validate before the write", and a 3 KB endpoint should be a
		// 400 on DELETE for the same reason it is a 400 on POST.
		const endpoint = validateEndpoint(body.endpoint);
		deleteSubscription(getDb(), user.id, endpoint);
		return ok({ subscribed: false });
	});
