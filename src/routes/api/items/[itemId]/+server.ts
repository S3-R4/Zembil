/** `PATCH|DELETE /api/items/{itemId}` — CONTRACT.md §3.5, R-8, R-10. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { deleteItem, updateItem } from '$lib/server/domain/items';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const PATCH: RequestHandler = async ({ locals, params, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const result = updateItem(
			getDb(),
			params.itemId,
			{
				...(Object.hasOwn(body, 'name') ? { name: body.name } : {}),
				...(Object.hasOwn(body, 'note') ? { note: body.note } : {}),
				version: body.version
			},
			actor
		);
		return ok({ item: result.item, rev: result.rev });
	});

export const DELETE: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		const actor = actorOf(locals);
		const result = deleteItem(getDb(), params.itemId, actor);
		return ok({ item: result.item, rev: result.rev });
	});
