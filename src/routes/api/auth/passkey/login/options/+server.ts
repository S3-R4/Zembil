/** `POST /api/auth/passkey/login/options` — CONTRACT.md §3.2, §3.7. Auth: public. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok } from '$lib/server/domain/responses';
import { handleAuth, requestIp } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import { beginAuthentication } from '$lib/server/auth/webauthn';

export const POST: RequestHandler = async (event) =>
	handleAuth(async () => {
		// §3.7: this endpoint is public AND writes a `webauthn_challenges` row, so
		// without its own bucket an internet scanner can POST `{}` in a loop and
		// grow the database until /data is full and every write in the app fails.
		// The bucket is the brake; the reaper inside `beginAuthentication` is the
		// cleanup.
		enforce(limiters.passkeyOptionsByIp, requestIp(event));
		// No body is read: §3.2 specifies `{}` — no username. Reading one would
		// invite a future change that made the response depend on it, which is
		// what makes this flow enumeration-safe.
		const result = await beginAuthentication(getDb());
		return ok(result);
	});
