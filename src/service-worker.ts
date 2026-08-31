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
 * So the cache holds exactly three kinds of thing, all of them public and all
 * of them versioned or immutable: the hashed build assets, the static files,
 * and one static offline page.
 */
import { build, files, version } from '$service-worker';
import { cacheStrategy } from '$lib/client/cache-policy';

const CACHE = `zembil-${version}`;
const OFFLINE = '/offline.html';

/** Hashed build output plus static assets. Both are public by construction:
 *  anything in `static/` is served to anyone who asks for it, signed in or not. */
const PRECACHE = [...build, ...files];

const sw = self as unknown as ServiceWorkerGlobalScope;

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
	const strategy = cacheStrategy({
		method: request.method,
		url: request.url,
		origin: sw.location.origin,
		mode: request.mode,
		precache: PRECACHE
	});

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
					const cached = await caches.match(OFFLINE);
					return (
						cached ??
						new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
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
