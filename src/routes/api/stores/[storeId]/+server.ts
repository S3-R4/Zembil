/** `PATCH|DELETE /api/stores/{storeId}` — CONTRACT.md §3.4, §8.6, §9.1, R-14, R-23. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { deleteStore, updateStore } from '$lib/server/domain/stores';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const PATCH: RequestHandler = async ({ locals, params, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const store = updateStore(getDb(), params.storeId, body, actor);
		return ok({ store });
	});

/** §9.1 / R-23. Permanent, cascading, and available to anyone the store is
 *  visible to — the same set that can archive it. There is no admin exemption
 *  and no owner concept for a public store (D-045). */
export const DELETE: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		const actor = actorOf(locals);
		const deleted = deleteStore(getDb(), params.storeId, actor);
		return ok({ deleted });
	});
