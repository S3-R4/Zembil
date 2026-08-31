/** `POST /api/stores/{storeId}/items` — CONTRACT.md §3.5, R-2, R-17. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addItem } from '$lib/server/domain/items';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const POST: RequestHandler = async ({ locals, params, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const result = addItem(
			getDb(),
			params.storeId,
			{ name: body.name, note: body.note, clientId: body.clientId },
			actor
		);
		// R-17: an idempotent hit returns 200 with the existing row — which may
		// live on a LATER trip than the caller expected — instead of 201.
		return ok({ item: result.item, rev: result.rev }, result.created ? 201 : 200);
	});
