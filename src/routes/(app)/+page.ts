import { api } from '$lib/client/api';
import type { StoreSummary } from '$lib/types';
import type { PageLoad } from './$types';

/** Universal load: on the server the cookie is forwarded by SvelteKit's fetch,
 *  so the home screen arrives rendered rather than as a spinner. */
export const load: PageLoad = async ({ fetch }) =>
	api<{ stores: StoreSummary[] }>('/api/stores', { fetch });
