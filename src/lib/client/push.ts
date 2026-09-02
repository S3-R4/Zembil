/**
 * Web push, the browser half — CONTRACT.md §8.7.
 *
 * The server's job here is small: it hands out a VAPID public key and stores
 * whatever `PushSubscription.toJSON()` produced. Everything awkward about push
 * is on this side, and most of it is not code but *diagnosis* — the common
 * outcomes are "this browser will never do this", "you said no once and I am not
 * allowed to ask again", and "you are on an iPhone and have not installed the
 * app", and each needs a different sentence to the member. A single "Enable"
 * button that silently does nothing is the failure this module exists to avoid.
 */
import { ApiError, api } from './api';
import type { PushKeyResponse, PushStatusResponse } from '$lib/types';

/**
 * Why the member cannot turn notifications on, or `null` when they can.
 *
 * `ios-home-screen` is the one worth the special case. Since iOS 16.4 Safari
 * exposes `Notification` and `PushManager` **only** to a PWA opened from the
 * Home Screen — in an ordinary tab they are simply absent, indistinguishable
 * from a browser that has never heard of push. Mobile Safari is this app's
 * primary target (PROJECT.md §13), so telling that member "this browser cannot
 * show notifications" would be both false and the most common thing we say.
 */
export type PushBlocker = 'unsupported' | 'ios-home-screen' | 'denied';

export function isIos(): boolean {
	if (typeof navigator === 'undefined') return false;
	if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
	// iPadOS 13+ reports itself as a Mac. A Mac with a touchscreen does not
	// exist, so the touch-point count is what separates them.
	return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function isStandalone(): boolean {
	if (typeof window === 'undefined') return false;
	if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
	// Safari's own non-standard flag, which is the only one iOS sets.
	return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** What is in the way, if anything. Does not prompt and has no side effects. */
export function pushBlocker(): PushBlocker | null {
	if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
	if (!('serviceWorker' in navigator)) return 'unsupported';
	if (!('PushManager' in window) || !('Notification' in window)) {
		return isIos() && !isStandalone() ? 'ios-home-screen' : 'unsupported';
	}
	if (Notification.permission === 'denied') return 'denied';
	return null;
}

/**
 * base64url → the `Uint8Array` `pushManager.subscribe` wants.
 *
 * `applicationServerKey` accepts a raw key as bytes and nothing else — a
 * base64url string is silently the wrong thing. Exported for its own unit test:
 * it is pure, it is easy to get wrong at the padding, and its failure mode is a
 * subscription that is created and then never receives anything.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - (value.length % 4)) % 4);
	const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	// `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`:
	// `applicationServerKey` will not accept a view that might sit on a
	// SharedArrayBuffer, and this one provably does not.
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
	// `ready` resolves only once a worker is active, which is what `subscribe`
	// requires. On a first-ever visit that can be a moment after load.
	return navigator.serviceWorker.ready;
}

/** The browser's current subscription for this origin, or `null`. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	if (pushBlocker() !== null) return null;
	const reg = await registration();
	return reg.pushManager.getSubscription();
}

export interface PushState extends PushStatusResponse {
	blocker: PushBlocker | null;
	/** The operator turned push off server-side (`503 PUSH_DISABLED`). */
	disabledOnServer: boolean;
}

/**
 * Reads the whole picture in one go: what this browser will allow, whether it
 * already has a subscription, and what the server knows about the member's
 * other devices.
 */
export async function readPushState(): Promise<PushState> {
	const blocker = pushBlocker();
	const empty = { subscribed: false, deviceCount: 0 };

	let status: PushStatusResponse = empty;
	let disabledOnServer = false;
	let endpoint: string | null = null;

	if (blocker === null) {
		const subscription = await currentSubscription();
		endpoint = subscription?.endpoint ?? null;
	}

	try {
		const query = endpoint === null ? '' : `?endpoint=${encodeURIComponent(endpoint)}`;
		status = await api<PushStatusResponse>(`/api/push/subscription${query}`);
	} catch (err) {
		// §8.7: the operator switched push off. Not a failure to report — the
		// section simply disappears rather than offering a broken control.
		if (err instanceof ApiError && err.code === 'PUSH_DISABLED') disabledOnServer = true;
		else throw err;
	}

	return { ...status, blocker, disabledOnServer };
}

/**
 * Asks permission, subscribes, and registers with the server.
 *
 * Returns `false` when the member dismissed the OS prompt, which is not an
 * error and must not be shown as one — they said "not now", and the UI says the
 * same thing back.
 */
export async function enablePush(): Promise<boolean> {
	if (pushBlocker() !== null) return false;

	// Must be called from a user gesture; every caller here is a click handler.
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return false;

	const { publicKey } = await api<PushKeyResponse>('/api/push/key');
	const reg = await registration();

	// Reuse an existing subscription rather than creating a second one. A
	// browser only ever has one per registration, and `subscribe` with a
	// different key on top of an existing subscription throws.
	const existing = await reg.pushManager.getSubscription();
	const subscription =
		existing ??
		(await reg.pushManager.subscribe({
			// Required by every browser that implements push: a payload-less
			// "silent" push is not allowed, and asking for one fails the subscribe.
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(publicKey)
		}));

	const json = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> };
	if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
		throw new Error('This browser produced a push subscription Zembil cannot use.');
	}

	await api('/api/push/subscription', {
		method: 'POST',
		body: {
			endpoint: json.endpoint,
			keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
		}
	});
	return true;
}

/**
 * Unsubscribes this browser and tells the server to forget it.
 *
 * The server is told FIRST. If `unsubscribe()` succeeds and the DELETE then
 * fails, the row survives with an endpoint no push service will ever accept
 * again, and the member sees "on" on a device that is off. This order leaves
 * the opposite, recoverable gap instead: a browser subscription with no row,
 * which delivers nothing and is cleaned up the next time they enable.
 */
export async function disablePush(): Promise<void> {
	const subscription = await currentSubscription();
	if (subscription) {
		await api('/api/push/subscription', {
			method: 'DELETE',
			body: { endpoint: subscription.endpoint }
		});
		await subscription.unsubscribe();
	}
}
