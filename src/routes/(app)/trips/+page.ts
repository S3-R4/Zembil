import { loadApi } from '$lib/client/load';
import type { StoreSummary } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) =>
	loadApi<{ stores: StoreSummary[] }>('/api/stores', { fetch });
