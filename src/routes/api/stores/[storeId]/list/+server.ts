/** `GET /api/stores/{storeId}/list` — CONTRACT.md §3.5, R-13. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getOpenList } from '$lib/server/domain/items';
import { actorOf, handle, ok } from '$lib/server/domain/responses';

export const GET: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		const actor = actorOf(locals);
		return ok(getOpenList(getDb(), params.storeId, actor.id));
	});
