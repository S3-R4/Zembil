/**
 * The HTTP adapter for the domain layer — CONTRACT.md §3.1.
 *
 * The domain modules themselves import nothing from a framework and return plain
 * objects; this file is the single place those objects and errors become
 * responses. It lives under `domain/` only because that directory is owned by
 * the same agent as the routes it serves.
 */
import { json } from '@sveltejs/kit';
import { DomainError, isDomainError } from './errors.js';
import type { Actor } from './stores.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function ok(body: unknown, status = 200): Response {
	return json(body, { status, headers: HEADERS });
}

/**
 * §3.1: every non-2xx response carries `{ error: { code, message } }`. The only
 * named sibling fields are `item` (VERSION_CONFLICT), `openTripId`
 * (TRIP_ALREADY_CLOSED) and `storeId` (STORE_NAME_TAKEN, §3.4). Nothing is ever
 * nested inside `error`.
 */
export function errorResponse(err: DomainError): Response {
	const body: Record<string, unknown> = {
		error: { code: err.code, message: err.message }
	};
	if (err.extra) for (const [k, v] of Object.entries(err.extra)) body[k] = v;
	return json(body, { status: err.status, headers: HEADERS });
}

export function unauthenticated(): Response {
	return errorResponse(new DomainError('UNAUTHENTICATED', 401, 'Please sign in.'));
}

/** Reads the actor from `locals.user` — never from the request body. */
export function actorOf(locals: App.Locals): Actor {
	const user = locals.user;
	if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'Please sign in.');
	// §8.4a: `isAdmin` comes from the session's user row and from nothing else —
	// never a body, never a query parameter, either of which would let a caller
	// name their own privilege.
	return { id: user.id, isAdmin: user.isAdmin };
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		const text = await request.text();
		parsed = text.length === 0 ? {} : JSON.parse(text);
	} catch {
		throw new DomainError('VALIDATION_FAILED', 400, 'Request body must be JSON.');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new DomainError('VALIDATION_FAILED', 400, 'Request body must be a JSON object.');
	}
	return parsed as Record<string, unknown>;
}

/** Wraps a handler so a DomainError becomes its envelope and nothing else leaks. */
export async function handle(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		if (isDomainError(err)) return errorResponse(err);
		// Diagnostic detail goes to the server log only; the client gets nothing.
		console.error('[zembil] unhandled error', err);
		return errorResponse(
			new DomainError('INTERNAL', 500, 'Something went wrong. Please try again.')
		);
	}
}
