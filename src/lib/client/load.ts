/**
 * The fetch wrapper for `load` functions.
 *
 * `api()` throws an `ApiError`, and a `load` that lets one escape gets
 * SvelteKit's generic `500 Internal Error` page — for a store that was removed,
 * for a non-admin who followed a link to `/you/admin`, and for anyone whose
 * connection blinks mid-navigation. All three of those have an honest answer
 * from the server (§3.1 writes `message` to be shown to a person), and a 500
 * throws it away at exactly the layer that renders.
 */
import { error } from '@sveltejs/kit';
import { ApiError, OfflineError, api, type ApiOptions } from './api';

export async function loadApi<T>(path: string, options: ApiOptions = {}): Promise<T> {
	try {
		return await api<T>(path, options);
	} catch (err) {
		if (err instanceof ApiError) {
			// The code rides along so `+error.svelte` can tell "you are not allowed"
			// from "it is not there" without parsing prose.
			error(err.status, { message: err.message, code: err.code });
		}
		if (err instanceof OfflineError) {
			error(503, { message: 'No signal.', code: 'OFFLINE' });
		}
		throw err;
	}
}
