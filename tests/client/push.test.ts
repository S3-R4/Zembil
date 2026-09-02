/**
 * The browser push helper — CONTRACT.md §8.7.
 *
 * Only the parts that are pure or that can be driven with a stubbed `navigator`
 * and `window`. The interesting logic here is diagnosis, not transport: which of
 * "this browser never will", "you said no once", and "you are on an iPhone and
 * have not installed the app" applies. Getting that wrong shows the member a
 * button that silently does nothing, which is the failure the module exists to
 * prevent.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { base64UrlToBytes, isIos, isStandalone, pushBlocker } from '$lib/client/push';

const original = {
	navigator: globalThis.navigator,
	window: (globalThis as any).window,
	Notification: (globalThis as any).Notification
};

function stub(options: {
	userAgent?: string;
	platform?: string;
	maxTouchPoints?: number;
	serviceWorker?: boolean;
	pushManager?: boolean;
	notification?: false | NotificationPermission;
	standalone?: boolean;
	displayMode?: boolean;
}) {
	const nav: any = {
		userAgent: options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64)',
		platform: options.platform ?? 'Linux x86_64',
		maxTouchPoints: options.maxTouchPoints ?? 0
	};
	if (options.serviceWorker !== false) nav.serviceWorker = {};
	if (options.standalone !== undefined) nav.standalone = options.standalone;

	const win: any = {
		matchMedia: () => ({ matches: options.displayMode ?? false })
	};
	if (options.pushManager !== false) win.PushManager = function () {};
	if (options.notification !== false) {
		win.Notification = { permission: options.notification ?? 'default' };
		(globalThis as any).Notification = win.Notification;
	} else {
		delete (globalThis as any).Notification;
	}

	vi.stubGlobal('navigator', nav);
	vi.stubGlobal('window', win);
}

afterEach(() => {
	vi.unstubAllGlobals();
	(globalThis as any).Notification = original.Notification;
});

describe('base64UrlToBytes', () => {
	// `applicationServerKey` accepts raw bytes and nothing else; a base64url
	// string is silently the wrong thing, and the failure mode is a subscription
	// that is created and then never receives anything.
	test('round-trips the standard alphabet', () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
		const b64url = Buffer.from(bytes)
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(Array.from(base64UrlToBytes(b64url))).toEqual(Array.from(bytes));
	});

	test('handles every padding length', () => {
		for (const length of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const bytes = new Uint8Array(length).fill(7);
			const b64url = Buffer.from(bytes).toString('base64url');
			expect(base64UrlToBytes(b64url).length, `length ${length}`).toBe(length);
		}
	});

	test('decodes a real 65-byte VAPID key to 65 bytes', () => {
		// An uncompressed P-256 point: 0x04 plus two 32-byte coordinates. If the
		// padding maths were wrong this comes out 64 or throws.
		const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]);
		expect(base64UrlToBytes(key.toString('base64url')).length).toBe(65);
	});

	test('produces a view on a plain ArrayBuffer', () => {
		// Not a detail: `applicationServerKey` rejects a view that might sit on a
		// SharedArrayBuffer, and that rejection is a type error at build time and
		// a runtime failure if it slips through.
		expect(base64UrlToBytes('AAAA').buffer).toBeInstanceOf(ArrayBuffer);
	});
});

describe('pushBlocker', () => {
	test('null when everything is available and permission is undecided', () => {
		stub({});
		expect(pushBlocker()).toBe(null);
	});

	test('null when permission was already granted', () => {
		stub({ notification: 'granted' });
		expect(pushBlocker()).toBe(null);
	});

	test('"denied" when the member already said no — we may not ask again', () => {
		stub({ notification: 'denied' });
		expect(pushBlocker()).toBe('denied');
	});

	test('"unsupported" with no service worker at all', () => {
		stub({ serviceWorker: false });
		expect(pushBlocker()).toBe('unsupported');
	});

	test('"unsupported" on a desktop browser with no PushManager', () => {
		stub({ pushManager: false });
		expect(pushBlocker()).toBe('unsupported');
	});

	test('"ios-home-screen" for Safari in a TAB on iPhone', () => {
		// Since iOS 16.4, Safari exposes Notification and PushManager only to an
		// installed PWA. In a tab they are simply absent — indistinguishable from
		// a browser that never heard of push, which is why this case is special.
		stub({
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15',
			pushManager: false,
			notification: false
		});
		expect(pushBlocker()).toBe('ios-home-screen');
	});

	test('…and NOT once the same iPhone has it on the Home Screen', () => {
		stub({
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15',
			standalone: true
		});
		expect(pushBlocker()).toBe(null);
	});

	test('an installed iPhone PWA missing the APIs is honestly "unsupported"', () => {
		stub({
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) Safari/605.1.15',
			standalone: true,
			pushManager: false,
			notification: false
		});
		// Standalone and still no API means an older iOS: the Home Screen advice
		// would be wrong, and telling someone to do what they already did is
		// worse than saying it will not work.
		expect(pushBlocker()).toBe('unsupported');
	});
});

describe('iOS and standalone detection', () => {
	test('detects iPhone and iPad by user agent', () => {
		for (const ua of ['... (iPhone; CPU iPhone OS 17_0 ...)', '... (iPad; CPU OS 16_0 ...)']) {
			stub({ userAgent: ua });
			expect(isIos(), ua).toBe(true);
		}
	});

	test('detects iPadOS 13+, which reports itself as a Mac', () => {
		// A Mac with a touchscreen does not exist, so the touch-point count is
		// what separates an iPad from the Mac it claims to be.
		stub({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 });
		expect(isIos()).toBe(true);
	});

	test('a real Mac is not iOS', () => {
		stub({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 0 });
		expect(isIos()).toBe(false);
	});

	test('standalone is true for display-mode and for Safari own flag', () => {
		stub({ displayMode: true });
		expect(isStandalone()).toBe(true);
		stub({ standalone: true });
		expect(isStandalone()).toBe(true);
		stub({});
		expect(isStandalone()).toBe(false);
	});
});
