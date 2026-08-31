/**
 * `GET /api/health` — CONTRACT.md §3.8.
 *
 * The only unauthenticated endpoint in the application and the only one exempt
 * from the Origin check. It returns two words and nothing else: no version, no
 * uptime, no migration number, no user count, no error text. This is reachable
 * from the public internet by anyone who finds the hostname, and a health
 * endpoint that reports the build is a free fingerprint for picking a matching
 * CVE. Diagnostic detail goes to the log, where an operator can already read it.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export const GET: RequestHandler = async () => {
	try {
		getDb().prepare('SELECT 1').get();
	} catch (err) {
		// The 503 is what makes this endpoint worth having: the container must
		// report unhealthy when the database is gone, or Docker restarts nothing
		// while every real request 500s.
		console.error('[zembil] health check failed', err);
		return json({ status: 'unavailable' }, { status: 503, headers: HEADERS });
	}
	return json({ status: 'ok' }, { status: 200, headers: HEADERS });
};
