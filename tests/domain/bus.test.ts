/**
 * CONTRACT.md §4 and §4.1 — the in-process bus and the SSE wire format.
 *
 * The export surface is frozen because zembil-auth imports it and the two agents
 * never see each other's code (D-025). These tests are what would catch a rename.
 */
import { afterEach, describe, expect, test } from 'vitest';
import * as bus from '$lib/server/realtime/bus';
import type { ZembilEvent } from '$lib/types';

afterEach(() => bus.resetBus());

function listener(userId: string, sessionId: string) {
	const events: ZembilEvent[] = [];
	let closed = false;
	const off = bus.subscribe(
		userId,
		sessionId,
		(e) => {
			events.push(e);
		},
		() => {
			closed = true;
		}
	);
	return {
		events,
		get closed() {
			return closed;
		},
		off
	};
}

describe('§4.1 — the frozen export surface', () => {
	test('every pinned function exists with the pinned arity', () => {
		expect(typeof bus.emitStoreChanged).toBe('function');
		expect(bus.emitStoreChanged.length).toBe(2);
		expect(typeof bus.emitStoresChanged).toBe('function');
		expect(bus.emitStoresChanged.length).toBe(0);
		expect(typeof bus.revokeSession).toBe('function');
		expect(bus.revokeSession.length).toBe(1);
		expect(typeof bus.revokeUserStreams).toBe('function');
		expect(bus.revokeUserStreams.length).toBe(1);
		expect(typeof bus.subscribe).toBe('function');
		// §4.1 types the fourth parameter as `close?: () => void`; it is implemented
		// with a default value, which emits that same optional declaration while
		// keeping `length` at the pinned 3. This assertion is what guarantees
		// zembil-auth's three-argument call still compiles.
		expect(bus.subscribe.length).toBe(3);
	});

	test('subscribe returns an unsubscribe function that actually detaches', () => {
		const a = listener('u1', 's1');
		bus.emitStoresChanged();
		a.off();
		bus.emitStoresChanged();
		expect(a.events).toHaveLength(1);
		expect(bus.streamCount()).toBe(0);
	});

	test('a three-argument subscribe call still works', () => {
		const events: ZembilEvent[] = [];
		const off = bus.subscribe('u1', 's1', (e) => events.push(e));
		bus.emitStoresChanged();
		off();
		expect(events).toHaveLength(1);
	});

	test('revocation and the stream cap tolerate a subscriber that passed no close', () => {
		const events: ZembilEvent[] = [];
		bus.subscribe('u1', 's1', (e) => events.push(e));
		// Nothing was passed to close with: the bus must still drop the stream and
		// must not throw on the missing argument.
		expect(() => bus.revokeSession('s1')).not.toThrow();
		expect(events).toEqual([{ v: 1, type: 'session.revoked' }]);
		expect(bus.streamCount('s1')).toBe(0);

		for (let i = 0; i < bus.MAX_STREAMS_PER_SESSION + 1; i += 1) {
			expect(() => bus.subscribe('u1', 's2', () => {})).not.toThrow();
		}
		expect(bus.streamCount('s2')).toBe(bus.MAX_STREAMS_PER_SESSION);
	});
});

describe('§4 — event payloads', () => {
	test('store.changed carries v, type, storeId and rev; stores.changed carries only v and type', () => {
		const a = listener('u1', 's1');
		bus.emitStoreChanged('store-1', 42);
		bus.emitStoresChanged();
		expect(a.events[0]).toEqual({ v: 1, type: 'store.changed', storeId: 'store-1', rev: 42 });
		expect(a.events[1]).toEqual({ v: 1, type: 'stores.changed' });
	});

	test('every event serializes to a single line, as the wire format requires', () => {
		const a = listener('u1', 's1');
		bus.emitStoreChanged('store-1', 42);
		bus.emitStoresChanged();
		bus.revokeSession('s1');
		for (const event of a.events) {
			const json = JSON.stringify(event);
			expect(json.includes('\n')).toBe(false);
			expect(`data: ${json}\n\n`.split('\n')).toHaveLength(3);
		}
	});

	test('events fan out to every stream', () => {
		const a = listener('u1', 's1');
		const b = listener('u2', 's2');
		bus.emitStoreChanged('store-1', 1);
		expect(a.events).toHaveLength(1);
		expect(b.events).toHaveLength(1);
	});
});

describe('revocation tears the stream down immediately', () => {
	test('revokeSession notifies and closes only the matching session', () => {
		const a = listener('u1', 's1');
		const b = listener('u1', 's2');
		bus.revokeSession('s1');
		expect(a.events).toEqual([{ v: 1, type: 'session.revoked' }]);
		expect(a.closed).toBe(true);
		expect(b.events).toEqual([]);
		expect(b.closed).toBe(false);
		expect(bus.streamCount()).toBe(1);
	});

	test('revokeUserStreams notifies and closes every stream of that user only', () => {
		const a = listener('u1', 's1');
		const b = listener('u1', 's2');
		const c = listener('u2', 's3');
		bus.revokeUserStreams('u1');
		expect(a.closed && b.closed).toBe(true);
		expect(c.closed).toBe(false);
		expect(bus.streamCount()).toBe(1);
	});

	test('both are no-ops when nothing matches', () => {
		const a = listener('u1', 's1');
		bus.revokeSession('nobody');
		bus.revokeUserStreams('nobody');
		expect(a.events).toEqual([]);
		expect(a.closed).toBe(false);
	});

	test('a revoked stream receives nothing afterwards', () => {
		const a = listener('u1', 's1');
		bus.revokeSession('s1');
		bus.emitStoresChanged();
		expect(a.events).toHaveLength(1);
	});
});

describe('§4 — at most 4 concurrent streams per session, oldest closed first', () => {
	test('a fifth stream evicts the oldest of that session and nobody else', () => {
		const own = [listener('u1', 's1'), listener('u1', 's1'), listener('u1', 's1'), listener('u1', 's1')];
		const other = listener('u2', 's2');
		expect(bus.streamCount('s1')).toBe(4);

		const fifth = listener('u1', 's1');
		expect(bus.streamCount('s1')).toBe(4);
		expect(own[0].closed).toBe(true);
		expect(own.slice(1).some((s) => s.closed)).toBe(false);
		expect(other.closed).toBe(false);

		bus.emitStoresChanged();
		expect(own[0].events).toHaveLength(0);
		expect(fifth.events).toHaveLength(1);
	});

	test('the cap is per session, not global', () => {
		for (let i = 0; i < 4; i += 1) listener('u1', 's1');
		for (let i = 0; i < 4; i += 1) listener('u1', 's2');
		expect(bus.streamCount()).toBe(8);
	});

	test('a listener that throws is dropped without taking the emitter down', () => {
		bus.subscribe(
			'u1',
			's1',
			() => {
				throw new Error('socket gone');
			},
			() => {}
		);
		const healthy = listener('u2', 's2');
		expect(() => bus.emitStoresChanged()).not.toThrow();
		expect(healthy.events).toHaveLength(1);
		expect(bus.streamCount()).toBe(1);
	});
});
