/**
 * The HTTP wrapper for auth routes — CONTRACT.md §3.1, §3.7.
 *
 * Identical to `domain/responses.handle` except for one thing: a `429` from
 * §3.7 must carry a `Retry-After` header, and the header is not part of the
 * error envelope, so it cannot be expressed through `DomainError.extra` (§3.1
 * permits exactly three named sibling fields, and this is not one of them).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DomainError, isDomainError } from '../domain/errors.js';
import { errorResponse } from '../domain/responses.js';
import { RateLimitedError, clientIp } from './ratelimit.js';

export async function handleAuth(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof RateLimitedError) {
			const response = errorResponse(err);
			response.headers.set('Retry-After', String(err.retryAfter));
			return response;
		}
		if (isDomainError(err)) return errorResponse(err);
		console.error('[zembil] unhandled error', err);
		return errorResponse(
			new DomainError('INTERNAL', 500, 'Something went wrong. Please try again.')
		);
	}
}

/**
 * §3.7 / D-007. `getClientAddress()` is the socket peer address — adapter-node
 * derives it from the connection unless `ADDRESS_HEADER` is set, which §6
 * forbids alongside `PROTOCOL_HEADER` and `HOST_HEADER`.
 */
export function requestIp(event: RequestEvent): string {
	let socketAddress = 'unknown';
	try {
		socketAddress = event.getClientAddress();
	} catch {
		// Some adapters throw when no address is available. One shared bucket for
		// those requests is a worse brake than a real address but is still a brake,
		// and it must never be the reason a request fails.
	}
	return clientIp(event.request.headers, socketAddress);
}
