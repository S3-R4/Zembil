/**
 * Push delivery — CONTRACT.md §8.7, R-21, §8.8.
 *
 * This is the sink the coalescer hands a `NotificationBatch` to once a store's
 * list has gone quiet. It is the ONLY module that talks to a push service, and
 * it is the boundary at which a shopping list stops being a shopping list and
 * becomes text on somebody else's lock screen. Three rules follow from that:
 *
 * - **Recipients are computed here, from the database, at delivery time** — not
 *   carried in the batch. The batch holds ids; the store name, the recipient
 *   set and each recipient's locale are all resolved now. A store renamed
 *   during the quiet window notifies under its current name, a member
 *   deactivated during the window is not notified, and a store that has been
 *   deleted notifies nobody.
 *
 * - **Visibility (§8.4) is applied to the recipient query itself.** The
 *   consequence is worth stating because it looks like a bug when you meet it
 *   in a test: **a private store notifies nobody.** Its only viewer is its
 *   owner, and the owner is the person who did the adding, so the recipient set
 *   is empty by construction.
 *
 * - **Nothing here is ever visible to the person whose write triggered it.**
 *   `deliverBatch` does not throw. A push service being down, a subscription
 *   being stale, a payload being rejected — all of it is logged and swallowed.
 *   The alternative is a 500 on "add milk" because Mozilla's push service had a
 *   bad afternoon.
 *
 * The one seam: `setPushTransport`. Tests replace the outbound HTTPS call and
 * NOTHING else — the database, the recipient query, the payload composition and
 * the failure handling are all real, per PROJECT.md §11 ("a test that mocks
 * these tests the mock"). The seam is at the HTTP boundary because that is the
 * only part of this module a test genuinely cannot run.
 */
import webpush from 'web-push';
import type { Db } from '../db/index.js';
import type { NotificationBatch, NotificationSink } from '../notify/index.js';
import { getVapidKeys } from './keys.js';
import { composePayload } from './messages.js';
import {
	deleteSubscriptionByEndpoint,
	listSubscriptions,
	recordFailure,
	recordSuccess,
	type SubscriptionRow
} from './subscriptions.js';

/** The slice of `AuthConfig` delivery needs. `AuthConfig` satisfies it. */
export interface PushDeliveryConfig {
	pushEnabled: boolean;
	/** `null` when no valid contact URI could be derived — see `AuthConfig`. */
	vapidSubject: string | null;
}

export interface TransportSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface TransportOptions {
	vapidDetails: { subject: string; publicKey: string; privateKey: string };
	TTL: number;
}

export type PushTransport = (
	subscription: TransportSubscription,
	payload: string,
	options: TransportOptions
) => Promise<{ statusCode: number }>;

/**
 * Six hours. Long enough that a phone in a pocket on a plane still gets the
 * list when it lands; short enough that a push service is not still holding
 * "Migros: milk and 3 more" the following evening, by which time somebody has
 * done the shopping and the notification is a lie.
 */
const TTL_SECONDS = 6 * 60 * 60;

const defaultTransport: PushTransport = (subscription, payload, options) =>
	webpush.sendNotification(subscription, payload, options);

let transport: PushTransport = defaultTransport;

/** Test seam. `null` restores the real `web-push` call. */
export function setPushTransport(next: PushTransport | null): void {
	transport = next ?? defaultTransport;
}

export interface DeliveryReport {
	/** Why nothing was sent, when nothing was sent. */
	skipped: 'disabled' | 'no-vapid-subject' | 'store-gone' | 'no-recipients' | null;
	recipients: number;
	attempted: number;
	delivered: number;
	/** Rows deleted because the push service said 404/410. */
	pruned: number;
	/** Rows whose `failure_count` was incremented. */
	failed: number;
}

interface Recipient {
	id: string;
	locale: string;
}

interface StoreRow {
	name: string;
	private_to: string | null;
}

/**
 * §8.7 recipients: every user who is active, is not a contributor to this
 * batch, can see the store under §8.4, and has at least one subscription row.
 *
 * All four conditions are in the one statement on purpose. Filtering in
 * JavaScript afterwards would mean each condition could be dropped
 * independently while the query still "worked"; here every clause is on the
 * path that produces the row set, and a mutation sweep that removes any one of
 * them changes the result.
 */
export function recipientsFor(db: Db, storeId: string, actorIds: string[]): Recipient[] {
	const store = db
		.prepare('SELECT name, private_to FROM stores WHERE id = ?')
		.get(storeId) as unknown as StoreRow | undefined;
	if (!store) return [];

	// Placeholders — never values — are interpolated. §1.1a / D-003.
	const excluded = actorIds.length > 0 ? `AND u.id NOT IN (${actorIds.map(() => '?').join(',')})` : '';

	const rows = db
		.prepare(
			`SELECT DISTINCT u.id AS id, u.locale AS locale
			   FROM users u
			   JOIN push_subscriptions p ON p.user_id = u.id
			  WHERE u.is_active = 1
			    AND (? IS NULL OR u.id = ?)
			    ${excluded}
			  ORDER BY u.id ASC`
		)
		.all(store.private_to, store.private_to, ...actorIds) as unknown as Recipient[];

	return rows.map((r) => ({ id: r.id, locale: r.locale }));
}

function storeNameOf(db: Db, storeId: string): string | null {
	const row = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId) as unknown as
		| { name: string }
		| undefined;
	return row ? row.name : null;
}

/**
 * `web-push` rejects with a `WebPushError` carrying `statusCode`. Anything else
 * — DNS failure, socket timeout, a bug in this module — has no status code, and
 * "no status code" must NOT be read as 410: that would delete a live
 * subscription because the network blipped.
 */
function statusCodeOf(err: unknown): number | null {
	if (typeof err === 'object' && err !== null && 'statusCode' in err) {
		const code = (err as { statusCode: unknown }).statusCode;
		if (typeof code === 'number' && Number.isFinite(code)) return code;
	}
	return null;
}

/** §8.7: a 404 or 410 is the push service saying the browser is gone. */
function isGone(status: number): boolean {
	return status === 404 || status === 410;
}

/**
 * Delivers one batch. Never throws, never rejects — see the header. Exported
 * so tests can drive it directly rather than through a timer.
 */
export async function deliverBatch(
	db: Db,
	config: PushDeliveryConfig,
	batch: NotificationBatch
): Promise<DeliveryReport> {
	const report: DeliveryReport = {
		skipped: null,
		recipients: 0,
		attempted: 0,
		delivered: 0,
		pruned: 0,
		failed: 0
	};

	try {
		if (!config.pushEnabled) {
			report.skipped = 'disabled';
			return report;
		}

		// RFC 8292 requires a `mailto:` or `https:` contact URI in the VAPID JWT
		// and `web-push` enforces it, so with no subject there is nothing to send
		// — which is the local-development case (a plain-http origin), where a
		// browser could not receive real web push regardless. Logged once per
		// batch rather than per subscription: it is a configuration fact, not an
		// incident.
		const subject = config.vapidSubject;
		if (subject === null) {
			report.skipped = 'no-vapid-subject';
			console.warn(
				'[zembil] not sending push: no VAPID subject. Set ZEMBIL_VAPID_SUBJECT, ' +
					'or run behind an https origin so it can be derived. See CONTRACT.md §8.7.'
			);
			return report;
		}

		// Resolved now, not when the batch was armed (§8.7).
		const storeName = storeNameOf(db, batch.storeId);
		if (storeName === null) {
			report.skipped = 'store-gone';
			return report;
		}

		const recipients = recipientsFor(db, batch.storeId, batch.actorIds);
		report.recipients = recipients.length;
		if (recipients.length === 0) {
			report.skipped = 'no-recipients';
			return report;
		}

		const vapid = getVapidKeys(db);
		const options: TransportOptions = {
			vapidDetails: {
				subject,
				publicKey: vapid.publicKey,
				privateKey: vapid.privateKey
			},
			TTL: TTL_SECONDS
		};

		for (const recipient of recipients) {
			// Composed per recipient, in THAT recipient's locale (§8.5). Two
			// members with different locales get two different payloads for the
			// same batch, which is why this is inside the loop.
			const payload = JSON.stringify(
				composePayload(recipient.locale, {
					storeId: batch.storeId,
					storeName,
					names: batch.names,
					count: batch.count
				})
			);

			const subscriptions: SubscriptionRow[] = listSubscriptions(db, recipient.id);
			for (const sub of subscriptions) {
				report.attempted += 1;
				try {
					await transport(
						{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
						payload,
						options
					);
					recordSuccess(db, sub.id);
					report.delivered += 1;
				} catch (err) {
					const status = statusCodeOf(err);
					if (status !== null && isGone(status)) {
						deleteSubscriptionByEndpoint(db, sub.endpoint);
						report.pruned += 1;
					} else {
						recordFailure(db, sub.id);
						report.failed += 1;
						// The endpoint is logged, the keys and the payload are not.
						console.error(
							`[zembil] push delivery failed (status ${status ?? 'none'}) for ${sub.endpoint}`
						);
					}
				}
			}
		}
	} catch (err) {
		// Belt and braces around the whole thing: R-21's promise is that a push
		// failure is never visible to the person whose write triggered it, and
		// "never" includes a bug in this function.
		console.error('[zembil] push batch failed', err);
	}

	return report;
}

/**
 * §8.8: what `hooks.server.ts` installs via `setNotificationSink`. The wiring
 * belongs to the orchestrator; this module only supplies the function.
 */
export function createPushSink(db: Db, config: PushDeliveryConfig): NotificationSink {
	return async (batch: NotificationBatch) => {
		await deliverBatch(db, config, batch);
	};
}
