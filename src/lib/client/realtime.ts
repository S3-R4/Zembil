/**
 * The SSE client — CONTRACT.md §4.
 *
 * Events are HINTS. Nothing here patches state from a payload; every handler
 * asks the caller to refetch. That is what makes the client immune to
 * out-of-order delivery and to gaps across a reconnect.
 */
import type { ZembilEvent } from '$lib/types';

export interface RealtimeHandlers {
	/** A store's list changed. `rev` is the store's rev after that write. */
	storeChanged(storeId: string, rev: number): void;
	/** A store was created, renamed or archived. */
	storesChanged(): void;
	/** This session specifically. The client signs out. */
	sessionRevoked(): void;
	/**
	 * Revalidate everything on screen. Called on the EventSource `open` event —
	 * §4: EventSource reconnects by itself, and a proxy that drops an idle stream
	 * produces a reconnect with no mount, no visibilitychange, no focus and no
	 * online. A tablet left on the counter would otherwise miss every change made
	 * during the gap, forever. `open` covers reconnects by construction, and the
	 * first connect too.
	 */
	revalidate(): void;
}

/**
 * Parses one `data:` line into an event, or `null` for anything this client
 * should ignore.
 *
 * The forward-compatibility hinge (§4): an unrecognised `type` or a future `v`
 * is ignored in silence. A client that throws here cannot be upgraded without a
 * flag day, because every old phone in the house would start erroring the
 * moment the server learned a new event.
 */
export function parseEvent(data: unknown): ZembilEvent | null {
	if (typeof data !== 'string') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const event = parsed as Partial<ZembilEvent>;
	if (event.v !== 1) return null;
	if (event.type === 'store.changed') {
		const candidate = event as Extract<ZembilEvent, { type: 'store.changed' }>;
		if (typeof candidate.storeId !== 'string' || typeof candidate.rev !== 'number') return null;
		return candidate;
	}
	if (event.type === 'stores.changed' || event.type === 'session.revoked') {
		return event as ZembilEvent;
	}
	return null;
}

export function connectRealtime(handlers: RealtimeHandlers): () => void {
	if (typeof EventSource === 'undefined') return () => {};

	const source = new EventSource('/api/events', { withCredentials: true });

	source.addEventListener('open', () => handlers.revalidate());

	// §4: every event is UNNAMED, so this is the only listener. The client
	// dispatches on the parsed `type`; there is no addEventListener per type,
	// because the server sends no `event:` field.
	source.addEventListener('message', (event) => {
		const parsed = parseEvent((event as MessageEvent<string>).data);
		if (!parsed) return;
		switch (parsed.type) {
			case 'store.changed':
				handlers.storeChanged(parsed.storeId, parsed.rev);
				return;
			case 'stores.changed':
				handlers.storesChanged();
				return;
			case 'session.revoked':
				handlers.sessionRevoked();
				return;
		}
	});

	// Belt and braces (§4). A phone that spent an hour in a pocket resolves on
	// unlock even if the stream died without the browser noticing.
	const onVisible = () => {
		if (document.visibilityState === 'visible') handlers.revalidate();
	};
	const onFocus = () => handlers.revalidate();
	const onOnline = () => handlers.revalidate();

	document.addEventListener('visibilitychange', onVisible);
	window.addEventListener('focus', onFocus);
	window.addEventListener('online', onOnline);

	return () => {
		source.close();
		document.removeEventListener('visibilitychange', onVisible);
		window.removeEventListener('focus', onFocus);
		window.removeEventListener('online', onOnline);
	};
}
