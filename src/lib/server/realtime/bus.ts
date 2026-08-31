/**
 * In-process realtime bus — CONTRACT.md §4 and §4.1.
 *
 * The export surface below is frozen: zembil-auth imports `revokeSession` and
 * `revokeUserStreams` and the two agents never see each other's code (D-025).
 *
 * Events are hints, never data. Every emit happens AFTER the write transaction
 * commits; emitting inside means a client can refetch and read pre-commit state.
 */
import type { ZembilEvent } from '$lib/types';

interface Stream {
	userId: string;
	sessionId: string;
	send: (event: ZembilEvent) => void;
	/** Tears the HTTP response down. Supplied by the GET /api/events route, which
	 *  is the only caller that ever passes four arguments (§4.1). A three-argument
	 *  subscriber gets the no-op default and is dropped from the set instead. */
	close: () => void;
	/** Monotonic, so "oldest first" is well defined even within one millisecond. */
	seq: number;
}

/** §4: at most 4 concurrent streams per session, oldest closed first. */
export const MAX_STREAMS_PER_SESSION = 4;

const streams = new Set<Stream>();
let nextSeq = 1;

function deliver(stream: Stream, event: ZembilEvent): void {
	try {
		stream.send(event);
	} catch {
		// A dead stream must never take down the writer that emitted it. Tear it
		// down rather than merely dropping it: dropping alone leaves the HTTP
		// response open and off the bus, so the connection lingers holding a file
		// descriptor while receiving nothing. `terminate` is re-entrant-safe here
		// because it deletes before it closes, and the route's cancel handler will
		// also unsubscribe — both are idempotent.
		terminate(stream);
	}
}

function terminate(stream: Stream): void {
	streams.delete(stream);
	try {
		stream.close();
	} catch {
		/* already torn down */
	}
}

function broadcast(event: ZembilEvent): void {
	for (const stream of [...streams]) deliver(stream, event);
}

/** Fan out to every stream. Call AFTER the write transaction commits. */
export function emitStoreChanged(storeId: string, rev: number): void {
	broadcast({ v: 1, type: 'store.changed', storeId, rev });
}

export function emitStoresChanged(): void {
	broadcast({ v: 1, type: 'stores.changed' });
}

/** Auth-owned flows call these. Each sends `session.revoked` to the matching
 *  streams and then closes them. Both are no-ops when nothing matches. */
export function revokeSession(sessionId: string): void {
	for (const stream of [...streams]) {
		if (stream.sessionId !== sessionId) continue;
		deliver(stream, { v: 1, type: 'session.revoked' });
		terminate(stream);
	}
}

export function revokeUserStreams(userId: string): void {
	for (const stream of [...streams]) {
		if (stream.userId !== userId) continue;
		deliver(stream, { v: 1, type: 'session.revoked' });
		terminate(stream);
	}
}

/**
 * Registration, called by the GET /api/events route only. Returns an
 * unsubscribe function the route calls on client disconnect.
 *
 * `close` is how the bus tears a stream down from its own side — required by
 * the per-session stream cap in §4 (closing the oldest when a fifth opens) and
 * by revokeSession/revokeUserStreams. `send` alone cannot end a stream. It is
 * optional so that a three-argument call still compiles; the events route is
 * the only caller and it always passes four.
 */
export function subscribe(
	userId: string,
	sessionId: string,
	send: (event: ZembilEvent) => void,
	// §4.1 types this parameter as `close?: () => void`, and a default-valued
	// parameter emits exactly that in the declaration — while also keeping
	// `subscribe.length` at the pinned 3. A bare `close?:` would make `length` 4,
	// because only a default, not an optional marker, is excluded from the count.
	close: () => void = () => {}
): () => void {
	const stream: Stream = { userId, sessionId, send, close, seq: nextSeq++ };

	// Cap per session, oldest first. Without this a single authenticated family
	// member — and every account here is one, which is the stated threat model —
	// can exhaust the process's file descriptors and stop serving everyone.
	const forSession = [...streams]
		.filter((s) => s.sessionId === sessionId)
		.sort((a, b) => a.seq - b.seq);
	while (forSession.length >= MAX_STREAMS_PER_SESSION) {
		const oldest = forSession.shift();
		if (!oldest) break;
		terminate(oldest);
	}

	streams.add(stream);

	return () => {
		streams.delete(stream);
	};
}

/**
 * CONTRACT.md §3.8 graceful shutdown: closes every open stream so the HTTP
 * server can finish closing. An SSE response never ends on its own, so without
 * this a SIGTERM waits for the container's kill timeout instead of exiting 0.
 *
 * No `session.revoked` is sent first — nothing was revoked. Clients reconnect
 * and revalidate on `open` (§4), which is exactly the right behaviour across a
 * restart.
 *
 * Additive to the §4.1 surface rather than a change to it: the four functions
 * pinned there keep their signatures.
 */
export function closeAllStreams(): void {
	for (const stream of [...streams]) terminate(stream);
}

/** Introspection for tests. Not part of the §4.1 contract surface. */
export function streamCount(sessionId?: string): number {
	if (sessionId === undefined) return streams.size;
	let n = 0;
	for (const s of streams) if (s.sessionId === sessionId) n += 1;
	return n;
}

/** Test helper: drop every stream without notifying. Not used by application code. */
export function resetBus(): void {
	streams.clear();
}
