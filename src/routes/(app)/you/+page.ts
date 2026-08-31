import { loadApi } from '$lib/client/load';
import type { Passkey, User } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) =>
	loadApi<{ user: User; passkeys: Passkey[] }>('/api/me', { fetch });
