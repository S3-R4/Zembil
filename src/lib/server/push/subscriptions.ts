/**
 * Push subscriptions — CONTRACT.md §8.7, I-17.
 *
 * One row per browser install that has granted permission. Two things here are
 * security properties rather than conveniences, and both have a test:
 *
 * 1. **`endpoint` is UNIQUE table-wide, and re-registering MOVES the row** (I-17).
 *    The endpoint identifies a browser profile, not a person. If Ayşe signs out
 *    on the family tablet and Mehmet signs in, the browser hands us the same
 *    endpoint; leaving it on Ayşe's account would mean Mehmet's tablet keeps
 *    buzzing with Ayşe's notifications — a cross-account disclosure produced by
 *    doing nothing.
 *
 * 2. **Deleting an endpoint you do not own is a `200` that deletes nothing.**
 *    A `404` there would answer "does this endpoint belong to somebody else?",
 *    which is a probe for another member's devices. §8.7 is explicit; §8.4's
 *    reasoning about `404`-not-`403` is the same reasoning.
 *
 * Validation runs BEFORE the write, per §3.1a: the DDL's `CHECK`s on length are
 * the backstop that catches a route which forgot, and a constraint reaching the
 * user is a 500 where the contract promises a 400.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';
import { conflict, validationFailed } from '../domain/errors.js';

/** §8.7. Matches the DDL `CHECK`, which is the backstop rather than the check. */
export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_KEY_LENGTH = 256;
/** `sessions.user_agent` truncates at the same width, for the same reason. */
export const MAX_USER_AGENT_LENGTH = 256;

/**
 * §8.7: at most this many subscriptions per member. Beyond it,
 * `409 PUSH_DEVICE_LIMIT`.
 *
 * The M6 audit found this endpoint was the one place an authenticated member
 * could create unbounded rows: `endpoint` is a client-supplied URL and is the
 * row's identity, so every distinct URL is a new row on the `/data` volume —
 * and `deliverBatch` then makes one serial outbound HTTPS request per row on
 * every batch, to hosts the member chose.
 *
 * The reasoning is `MAX_ITEMS_PER_TRIP`'s, verbatim (§3.5): the stated threat
 * model is that every account holder is a person who could be careless or
 * compromised, and no such person should be able to make the database or an
 * outbound request volume unbounded by looping an endpoint. Twelve is far more
 * devices than anyone in a household of fewer than ten people will register,
 * and low enough that reaching it cannot hurt.
 */
export const MAX_SUBSCRIPTIONS_PER_USER = 12;

export interface SubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent: string | null;
}

export interface SubscriptionRow {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	failureCount: number;
}

/**
 * Base64url, unpadded, as `PushSubscription.toJSON()` produces. Padding is
 * tolerated because a client library may add it; anything outside the alphabet
 * is not, since these strings are handed to a crypto routine.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function validateEndpoint(value: unknown): string {
	if (typeof value !== 'string') throw validationFailed('endpoint must be text.');
	if (value.length === 0) throw validationFailed('endpoint cannot be empty.');
	if (value.length > MAX_ENDPOINT_LENGTH) {
		throw validationFailed(`endpoint is too long (max ${MAX_ENDPOINT_LENGTH}).`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw validationFailed('endpoint must be a URL.');
	}
	// https: only. The endpoint is a URL this server will make an outbound
	// request to, so anything else is both useless (no push service speaks it)
	// and an invitation to point us at `file:` or `http://169.254.169.254`.
	if (url.protocol !== 'https:') throw validationFailed('endpoint must be an https URL.');
	return value;
}

function validateKey(value: unknown, field: string): string {
	if (typeof value !== 'string') throw validationFailed(`${field} must be text.`);
	if (value.length === 0) throw validationFailed(`${field} cannot be empty.`);
	if (value.length > MAX_KEY_LENGTH) {
		throw validationFailed(`${field} is too long (max ${MAX_KEY_LENGTH}).`);
	}
	if (!BASE64URL_RE.test(value)) throw validationFailed(`${field} must be base64url.`);
	return value;
}

/**
 * §8.7: the request body is exactly `PushSubscription.toJSON()`, narrowed to
 * the three fields we store. `expirationTime` and any other field the browser
 * adds are ignored rather than rejected — they are the browser's, not the
 * caller's, and a future field must not start failing every registration.
 */
export function validateSubscriptionInput(
	body: Record<string, unknown>,
	userAgent: string | null = null
): SubscriptionInput {
	const keys = body.keys;
	if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
		throw validationFailed('keys must be an object.');
	}
	const k = keys as Record<string, unknown>;
	return {
		endpoint: validateEndpoint(body.endpoint),
		p256dh: validateKey(k.p256dh, 'p256dh'),
		auth: validateKey(k.auth, 'auth'),
		userAgent: truncateUserAgent(userAgent)
	};
}

export function truncateUserAgent(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.slice(0, MAX_USER_AGENT_LENGTH);
}

export interface UpsertResult {
	id: string;
	/** `true` → the route answers `201`; `false` → `200` (§8.7). */
	created: boolean;
	/** The row existed and belonged to somebody else (I-17). Diagnostic only. */
	moved: boolean;
}

/**
 * Upsert by `endpoint`, which is the subscription's identity across the whole
 * table. An endpoint already registered to another user is MOVED to the caller.
 *
 * The move resets `failure_count` and clears `last_success_at`: the row is now
 * a different account's device as far as delivery is concerned, and inheriting
 * the previous owner's failure history would prune it early.
 */
export function upsertSubscription(
	db: Db,
	userId: string,
	input: SubscriptionInput
): UpsertResult {
	return tx(db, () => {
		const existing = db
			.prepare('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?')
			.get(input.endpoint) as unknown as { id: string; user_id: string } | undefined;

		if (existing) {
			db.prepare(
				`UPDATE push_subscriptions
				    SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?,
				        failure_count = 0, last_success_at = NULL
				  WHERE id = ?`
			).run(userId, input.p256dh, input.auth, input.userAgent, existing.id);
			return { id: existing.id, created: false, moved: existing.user_id !== userId };
		}

		// Checked only on the create path, and INSIDE the transaction: a repeat
		// registration of an endpoint already held (the branch above) writes no
		// new row and must keep working at the limit, exactly as R-17's
		// idempotent add does at MAX_ITEMS_PER_TRIP.
		const countRow = db
			.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
			.get(userId) as { n: number };
		if (Number(countRow.n) >= MAX_SUBSCRIPTIONS_PER_USER) {
			throw conflict(
				'PUSH_DEVICE_LIMIT',
				'You have turned notifications on for too many devices. Turn them off on one first.'
			);
		}

		const id = randomUUID();
		db.prepare(
			`INSERT INTO push_subscriptions
			   (id, user_id, endpoint, p256dh, auth, user_agent, created_at,
			    last_success_at, failure_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`
		).run(id, userId, input.endpoint, input.p256dh, input.auth, input.userAgent, Date.now());
		return { id, created: true, moved: false };
	});
}

/**
 * §8.7: idempotent, and scoped to the caller. An endpoint belonging to somebody
 * else matches nothing and the caller cannot tell that from an endpoint that
 * never existed. The return value is for tests and logs, never for a status code.
 */
export function deleteSubscription(db: Db, userId: string, endpoint: string): number {
	const result = db
		.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
		.run(userId, endpoint);
	return Number(result.changes);
}

/** Deletes by endpoint alone. Delivery-side pruning only (a 404/410 from the
 *  push service is about the device, not about the account). */
export function deleteSubscriptionByEndpoint(db: Db, endpoint: string): number {
	const result = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
	return Number(result.changes);
}

export function countSubscriptions(db: Db, userId: string): number {
	const row = db
		.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
		.get(userId) as unknown as { n: number };
	return Number(row.n);
}

export function hasSubscription(db: Db, userId: string, endpoint: string): boolean {
	const row = db
		.prepare('SELECT 1 AS hit FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
		.get(userId, endpoint) as unknown as { hit: number } | undefined;
	return row !== undefined;
}

export function listSubscriptions(db: Db, userId: string): SubscriptionRow[] {
	const rows = db
		.prepare(
			`SELECT id, endpoint, p256dh, auth, failure_count
			   FROM push_subscriptions
			  WHERE user_id = ?
			  ORDER BY created_at ASC, id ASC`
		)
		.all(userId) as unknown as Array<{
		id: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		failure_count: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		endpoint: r.endpoint,
		p256dh: r.p256dh,
		auth: r.auth,
		failureCount: Number(r.failure_count)
	}));
}

/** §8.7 `GET /api/push/subscription?endpoint=…`. Both fields scoped to the caller. */
export function subscriptionStatus(
	db: Db,
	userId: string,
	endpoint: string | null
): { subscribed: boolean; deviceCount: number } {
	return {
		subscribed: endpoint === null ? false : hasSubscription(db, userId, endpoint),
		deviceCount: countSubscriptions(db, userId)
	};
}

export function recordSuccess(db: Db, subscriptionId: string): void {
	db.prepare(
		'UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?'
	).run(Date.now(), subscriptionId);
}

export function recordFailure(db: Db, subscriptionId: string): void {
	db.prepare(
		'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?'
	).run(subscriptionId);
}
