import type { User } from '$lib/types';

declare global {
	namespace App {
		interface Locals {
			/** Set by hooks.server.ts. Null for an unauthenticated request. */
			user: User | null;
			/** Opaque session row id, never the raw token. Null when unauthenticated. */
			sessionId: string | null;
		}
		interface Error {
			message: string;
			/** Set by `loadApi` so `+error.svelte` can distinguish an offline
			 *  failure from a real status without parsing prose. */
			code?: string;
		}
	}
}

export {};
