/**
 * What the service worker is allowed to do with a request.
 *
 * Extracted from `src/service-worker.ts` so the rule can be tested directly
 * rather than only through a browser. It is the most dangerous thing in the
 * frontend to get wrong — a cached signed-in document is the family's shopping
 * list left in a browser profile for whoever opens it next — and "we read the
 * worker and it looked right" is exactly the standard D-030 rejects.
 */
export type CacheStrategy =
	/** Do not touch it. Let the network answer and cache nothing. */
	| 'bypass'
	/** Network first; the STATIC offline page if the network is gone. */
	| 'navigate'
	/** Cache first. Only ever a content-hashed build asset or a static file. */
	| 'asset';

export interface RequestFacts {
	method: string;
	/** Absolute URL of the request. */
	url: string;
	/** The worker's own origin. */
	origin: string;
	/** `request.mode` — 'navigate' for a document load. */
	mode: string;
	/** The precached paths: `[...build, ...files]` from `$service-worker`. */
	precache: readonly string[];
}

/**
 * Reads the facts off a real `Request`. Separate from `cacheStrategy` so the
 * MAPPING is testable too: the rule being right is worth nothing if the worker
 * feeds it the wrong `mode` or the wrong origin, and no browser-level test in
 * this suite issues a cross-origin or non-GET request through the worker.
 */
export function factsFor(
	request: Request,
	origin: string,
	precache: readonly string[]
): RequestFacts {
	return { method: request.method, url: request.url, origin, mode: request.mode, precache };
}

export function cacheStrategy(facts: RequestFacts): CacheStrategy {
	// Only GET is cacheable at all.
	if (facts.method !== 'GET') return 'bypass';

	let url: URL;
	try {
		url = new URL(facts.url);
	} catch {
		return 'bypass';
	}

	// Someone else's origin is someone else's business.
	if (url.origin !== facts.origin) return 'bypass';

	// THE RULE. Every /api/ response is per-member, most are per-second, and the
	// event stream never ends. None of it is ours to keep.
	if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'bypass';

	// A navigation returns a server-rendered, signed-in document.
	if (facts.mode === 'navigate') return 'navigate';

	// Everything left must be something we precached, by exact membership. A
	// prefix test here would be a way to reach paths we never listed.
	return facts.precache.includes(url.pathname) ? 'asset' : 'bypass';
}
