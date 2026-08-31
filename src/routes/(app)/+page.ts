import { loadApi } from '$lib/client/load';
import type { StoreSummary } from '$lib/types';
import type { PageLoad } from './$types';

/** Universal load: on the server the cookie is forwarded by SvelteKit's fetch,
 *  so the home screen arrives rendered rather than as a spinner. */
export const load: PageLoad = async ({ fetch }) =>
	loadApi<{ stores: StoreSummary[] }>('/api/stores', { fetch });
