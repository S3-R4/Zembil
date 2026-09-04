/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
/**
 * The service worker — PLAN.md (PWA), CONTRACT.md §5.
 *
 * ONE RULE ABOVE ALL OTHERS: never cache an authenticated document or an API
 * response. A shopping list carries family members' names, and a cached
 * navigation response would sit in this browser's cache profile where the next
 * person to open the app — signed in as someone else, or signed out entirely —
 * could be served it. `Cache-Control: no-store` on every authenticated response
 * (§5) says the same thing; this is the half of it that does not depend on the
 * browser honouring a header inside a worker we wrote ourselves.
 *
 * So the cache holds public versioned/immutable assets, three static offline
 * pages, and one closed-set locale preference containing no account data.
 *
 * The `push` and `notificationclick` handlers added for §8.7 do not change any
 * of that: they read a payload the server encrypted for this browser, show it,
 * and open a URL. Nothing is written to the cache on either path.
 */
import { build, files, version } from '$service-worker';
import { cacheStrategy, factsFor } from '$lib/client/cache-policy';

const CACHE = `zembil-${version}`;
const OFFLINE = {
	en: '/offline-en.html',
	tr: '/offline-tr.html',
	de: '/offline-de.html'
} as const;
const LOCALE_KEY = '/__zembil-offline-locale';
type OfflineLocale = keyof typeof OFFLINE;

/** Hashed build output plus static assets. Both are public by construction:
 *  anything in `static/` is served to anyone who asks for it, signed in or not. */
const PRECACHE = [...build, ...files];

const sw = self as unknown as ServiceWorkerGlobalScope;

const isOfflineLocale = (value: unknown): value is OfflineLocale =>
	value === 'en' || value === 'tr' || value === 'de';

async function offlineLocale(): Promise<OfflineLocale> {
	const response = await caches.match(LOCALE_KEY);
	const value = response ? await response.text() : '';
	return isOfflineLocale(value) ? value : 'en';
}

sw.addEventListener('message', (event) => {
	const data = event.data as { type?: unknown; locale?: unknown } | null;
	if (!data || data.type !== 'locale.changed' || !isOfflineLocale(data.locale)) return;
	event.waitUntil(
		caches.open(CACHE).then((cache) =>
			cache.put(
				LOCALE_KEY,
				new Response(data.locale, {
					headers: { 'content-type': 'text/plain; charset=utf-8' }
				})
			)
		)
	);
});

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE);
			// A new build should take over the moment it is ready. There is one
			// origin and one app; waiting for every tab to close means a member sees
			// yesterday's bundle until they reboot the phone.
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const request = event.request;

	// The whole policy lives in `cacheStrategy`, which is unit-tested against the
	// paths that matter. This handler only carries it out.
	const strategy = cacheStrategy(factsFor(request, sw.location.origin, PRECACHE));

	if (strategy === 'bypass') return;

	// A navigation returns an SSR'd, signed-in document. Network only, always.
	// On failure the member gets a static page that contains nothing about them,
	// rather than a stale list belonging to whoever used this browser last.
	if (strategy === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					return await fetch(request);
				} catch {
					const cached = await caches.match(OFFLINE[await offlineLocale()]);
					return (
						cached ??
						new Response('Offline', {
							status: 503,
							headers: { 'content-type': 'text/plain' }
						})
					);
				}
			})()
		);
		return;
	}

	// 'asset': a precached, content-hashed build file or a static file. Cache
	// first is safe precisely because those URLs are content-hashed — a new build
	// has a new URL, so a stale hit is impossible rather than merely unlikely.
	event.respondWith(
		(async () => {
			const cached = await caches.match(request);
			if (cached) return cached;
			const response = await fetch(request);
			if (response.ok) {
				const cache = await caches.open(CACHE);
				cache.put(request, response.clone());
			}
			return response;
		})()
	);
});

// ---------------------------------------------------------------------------
// Web push — CONTRACT.md §8.7.
//
// The payload is composed on the SERVER, per recipient, in that recipient's
// language (§8.5), and it is already encrypted to this browser's own key. The
// worker therefore renders it as-is and translates nothing: it has no idea who
// is signed in, and a worker that outlived a sign-out would otherwise render a
// notification in the previous member's language.
//
// It carries no user ids, no item ids and no note text — only a store name, up
// to five item names, a count, and the URL to open.
// ---------------------------------------------------------------------------

interface ZembilPushPayload {
	title: string;
	body: string;
	/** `{ url: '/s/{storeId}' }` — where a tap should land. Nested under `data`
	 *  because that is the shape the server composes (`push/messages.ts`) and the
	 *  shape `showNotification` carries through to `notificationclick`. */
	data?: { url?: string };
	/** Coalescing key, so a second notification for the same shop replaces the
	 *  first rather than stacking. The whole point of R-21 is one buzz per shop
	 *  per burst, and the notification tray should agree with that. */
	tag?: string;
}

function parsePayload(event: PushEvent): ZembilPushPayload | null {
	if (!event.data) return null;
	try {
		const parsed: unknown = event.data.json();
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const candidate = parsed as Partial<ZembilPushPayload>;
		if (typeof candidate.title !== 'string' || typeof candidate.body !== 'string') return null;
		const url = candidate.data?.url;
		return {
			title: candidate.title,
			body: candidate.body,
			data: { url: typeof url === 'string' ? url : undefined },
			tag: typeof candidate.tag === 'string' ? candidate.tag : undefined
		};
	} catch {
		return null;
	}
}

sw.addEventListener('push', (event) => {
	const payload = parsePayload(event);

	// A push we cannot read still has to produce a visible notification. Every
	// browser that implements push requires `userVisibleOnly`, and silently
	// swallowing one is what gets a site's push permission revoked wholesale.
	const title = payload?.title ?? 'Zembil';
	const body = payload?.body ?? '';

	event.waitUntil(
		sw.registration.showNotification(title, {
			body,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			tag: payload?.tag,
			// With a tag set, `renotify` is what makes a REPLACED notification buzz
			// again — otherwise a second batch for the same shop updates the tray
			// silently and nobody looks.
			renotify: payload?.tag !== undefined,
			data: { url: payload?.data?.url ?? '/' }
		} as NotificationOptions)
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const data = event.notification.data as { url?: string } | undefined;
	const target = typeof data?.url === 'string' ? data.url : '/';

	event.waitUntil(
		(async () => {
			const url = new URL(target, sw.location.origin);
			// Same-origin only. `data.url` comes from our own server, but a URL that
			// reaches `openWindow` is worth pinning to the origin regardless — it is
			// one line, and the alternative is trusting every future change to the
			// payload composer.
			if (url.origin !== sw.location.origin) return;

			const clients = await sw.clients.matchAll({
				type: 'window',
				includeUncontrolled: true
			});

			// Focus a tab that is already on this list, rather than opening a second
			// one — a family member who taps three notifications should end up with
			// one app, not three.
			for (const client of clients) {
				if (client.url === url.href && 'focus' in client) {
					await client.focus();
					return;
				}
			}
			// Otherwise reuse any open Zembil window and navigate it.
			for (const client of clients) {
				if ('navigate' in client && 'focus' in client) {
					await client.focus();
					await client.navigate(url.href);
					return;
				}
			}
			await sw.clients.openWindow(url.href);
		})()
	);
});
