/**
 * The service worker's caching rule — PLAN.md M3 exit criterion.
 *
 * `tests/e2e/offline.spec.js` proves the worker behaves in a browser. This
 * proves the rule itself against the inputs a browser is unlikely to produce on
 * a good day and certain to produce on a bad one.
 */
import { describe, expect, it } from 'vitest';
import { cacheStrategy } from '$lib/client/cache-policy';

const ORIGIN = 'https://zembil.example.com';
const PRECACHE = [
	'/_app/immutable/entry/app.abc123.js',
	'/fonts/dm-sans-latin.woff2',
	'/offline.html'
];

const strategy = (over: Partial<Parameters<typeof cacheStrategy>[0]> = {}) =>
	cacheStrategy({
		method: 'GET',
		url: `${ORIGIN}/`,
		origin: ORIGIN,
		mode: 'no-cors',
		precache: PRECACHE,
		...over
	});

describe('never the API', () => {
	it('bypasses every /api/ path, whatever the mode', () => {
		for (const path of [
			'/api/me',
			'/api/stores',
			'/api/stores/abc/list',
			'/api/events',
			'/api/health',
			'/api/auth/login',
			'/api'
		]) {
			expect(strategy({ url: ORIGIN + path }), path).toBe('bypass');
			expect(strategy({ url: ORIGIN + path, mode: 'navigate' }), `${path} as navigation`).toBe(
				'bypass'
			);
		}
	});

	it('bypasses an /api/ path carrying a query string or a fragment', () => {
		expect(strategy({ url: `${ORIGIN}/api/stores?includeArchived=true` })).toBe('bypass');
		expect(strategy({ url: `${ORIGIN}/api/trips/x#y` })).toBe('bypass');
	});

	it('does not confuse a path that merely starts with the same letters', () => {
		// `/apiary` is not the API. The check is on the segment, not the prefix.
		expect(strategy({ url: `${ORIGIN}/apiary`, precache: ['/apiary'] })).toBe('asset');
	});
});

describe('never an authenticated document', () => {
	it('treats every navigation as network-first, never cache-first', () => {
		for (const path of ['/', '/trips', '/you', '/you/admin', '/s/abc123', '/login']) {
			expect(strategy({ url: ORIGIN + path, mode: 'navigate' }), path).toBe('navigate');
		}
	});

	it('does not fall through to the asset branch even for a precached path', () => {
		// Nothing may reach 'asset' with mode 'navigate' — not even /offline.html.
		expect(strategy({ url: `${ORIGIN}/offline.html`, mode: 'navigate' })).toBe('navigate');
	});
});

describe('assets', () => {
	it('caches exactly what was precached, and nothing else', () => {
		for (const path of PRECACHE) {
			expect(strategy({ url: ORIGIN + path }), path).toBe('asset');
		}
		for (const path of ['/_app/immutable/entry/app.OTHER.js', '/robots.txt', '/']) {
			expect(strategy({ url: ORIGIN + path }), path).toBe('bypass');
		}
	});

	it('matches by exact path, not by prefix', () => {
		// Neither direction. A shorter path is not a precached entry...
		expect(strategy({ url: `${ORIGIN}/_app/` })).toBe('bypass');
		expect(strategy({ url: `${ORIGIN}/fonts/` })).toBe('bypass');
		// ...and neither is a LONGER one that happens to start with one. This is
		// the direction a `startsWith` check gets wrong, and it is the direction
		// that matters: `/offline.html/…` is a path we never listed.
		expect(strategy({ url: `${ORIGIN}/offline.html.map` })).toBe('bypass');
		expect(strategy({ url: `${ORIGIN}/offline.html/anything` })).toBe('bypass');
		expect(strategy({ url: `${ORIGIN}/fonts/dm-sans-latin.woff2.bak` })).toBe('bypass');
	});
});

describe('everything else', () => {
	it('bypasses any method but GET', () => {
		for (const method of ['POST', 'PATCH', 'DELETE', 'HEAD', 'PUT']) {
			expect(strategy({ method, url: `${ORIGIN}/offline.html` }), method).toBe('bypass');
		}
	});

	it('bypasses another origin', () => {
		expect(strategy({ url: 'https://evil.example/offline.html' })).toBe('bypass');
		expect(strategy({ url: 'http://zembil.example.com/offline.html' })).toBe('bypass');
	});

	it('bypasses an unparseable URL rather than throwing inside the worker', () => {
		expect(strategy({ url: 'not a url' })).toBe('bypass');
	});
});
