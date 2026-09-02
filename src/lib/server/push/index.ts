/**
 * The push module's public surface — CONTRACT.md §8.7.
 *
 * Routes import from here; `hooks.server.ts` imports `createPushSink` from here
 * too. Nothing outside this directory reaches into `keys.ts` — that is the
 * module holding the private key, and keeping its import graph to one file is
 * how "the private key never leaves the server" stays checkable by reading.
 */
import { DomainError } from '../domain/errors.js';

export { getVapidPublicKey, getVapidKeys, resetVapidKeyCache, type VapidKeys } from './keys.js';
export {
	MAX_ENDPOINT_LENGTH,
	MAX_KEY_LENGTH,
	MAX_SUBSCRIPTIONS_PER_USER,
	MAX_USER_AGENT_LENGTH,
	countSubscriptions,
	deleteSubscription,
	deleteSubscriptionByEndpoint,
	hasSubscription,
	listSubscriptions,
	subscriptionStatus,
	truncateUserAgent,
	upsertSubscription,
	validateEndpoint,
	validateSubscriptionInput,
	type SubscriptionInput,
	type SubscriptionRow,
	type UpsertResult
} from './subscriptions.js';
export { composePayload, catalogueFor, type PushPayload } from './messages.js';
export {
	createPushSink,
	deliverBatch,
	recipientsFor,
	setPushTransport,
	type DeliveryReport,
	type PushDeliveryConfig,
	type PushTransport
} from './deliver.js';

/**
 * §8.10: `PUSH_DISABLED` (503), no sibling field. A 503 rather than a 404
 * because the endpoint exists and the operator turned it off — a client should
 * hide the toggle and try again after a restart, not conclude the route is gone.
 */
export function pushDisabled(): DomainError {
	return new DomainError(
		'PUSH_DISABLED',
		503,
		'Push notifications are turned off on this server.'
	);
}

/** Throws `503 PUSH_DISABLED` unless the operator has push switched on. */
export function requirePushEnabled(config: { pushEnabled: boolean }): void {
	if (!config.pushEnabled) throw pushDisabled();
}
