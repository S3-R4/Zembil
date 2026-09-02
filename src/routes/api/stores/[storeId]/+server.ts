/** `PATCH /api/stores/{storeId}` — CONTRACT.md §3.4, §8.6, R-14. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { updateStore } from '$lib/server/domain/stores';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const PATCH: RequestHandler = async ({ locals, params, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const store = updateStore(getDb(), params.storeId, body, actor);
		return ok({ store });
	});
