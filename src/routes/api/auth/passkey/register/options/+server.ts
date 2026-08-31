/** `POST /api/auth/passkey/register/options` — CONTRACT.md §3.2, §3.7. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ok } from '$lib/server/domain/responses';
import { handleAuth, requestIp } from '$lib/server/auth/http';
import { enforce, limiters } from '$lib/server/auth/ratelimit';
import { requireSession } from '$lib/server/auth/guards';
import { beginRegistration } from '$lib/server/auth/webauthn';
import { requireUser, userHandle } from '$lib/server/auth/users';

export const POST: RequestHandler = async (event) =>
	handleAuth(async () => {
		const user = requireSession(event.locals);
		// §3.7 counts both options endpoints in one bucket; this one writes a
		// challenge row too, and a session is not a reason to skip the brake.
		enforce(limiters.passkeyOptionsByIp, requestIp(event));

		const db = getDb();
		const row = requireUser(db, user.id);
		const result = await beginRegistration(db, row, userHandle(db, user.id));
		return ok(result);
	});
