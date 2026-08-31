import { loadApi } from '$lib/client/load';
import type { AdminUser } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) =>
	loadApi<{ users: AdminUser[] }>('/api/admin/users', { fetch });
