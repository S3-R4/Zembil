/** CONTRACT.md §4 — the wire format, and the forward-compatibility hinge. */
import { describe, expect, it } from 'vitest';
import { parseEvent } from '$lib/client/realtime';

const line = (o: unknown) => JSON.stringify(o);

describe('parseEvent', () => {
	it('accepts the three events §4 defines', () => {
		expect(parseEvent(line({ v: 1, type: 'store.changed', storeId: 'abc', rev: 42 }))).toEqual({
			v: 1,
			type: 'store.changed',
			storeId: 'abc',
			rev: 42
		});
		expect(parseEvent(line({ v: 1, type: 'stores.changed' }))).toEqual({
			v: 1,
			type: 'stores.changed'
		});
		expect(parseEvent(line({ v: 1, type: 'session.revoked' }))).toEqual({
			v: 1,
			type: 'session.revoked'
		});
	});

	it('ignores a future version in silence', () => {
		// The hinge. A client that threw here could not be upgraded without a flag
		// day: every phone in the house would start erroring the moment the server
		// learned a new event.
		expect(parseEvent(line({ v: 2, type: 'store.changed', storeId: 'a', rev: 1 }))).toBeNull();
		expect(parseEvent(line({ type: 'stores.changed' }))).toBeNull();
		expect(parseEvent(line({ v: '1', type: 'stores.changed' }))).toBeNull();
	});

	it('ignores an unrecognised type in silence', () => {
		expect(parseEvent(line({ v: 1, type: 'item.exploded' }))).toBeNull();
		expect(parseEvent(line({ v: 1 }))).toBeNull();
	});

	it('ignores a store.changed missing its cursor', () => {
		// Without a numeric rev the client cannot suppress its own echo, and
		// treating a missing one as 0 would refetch the whole list on every write.
		expect(parseEvent(line({ v: 1, type: 'store.changed', storeId: 'a' }))).toBeNull();
		expect(parseEvent(line({ v: 1, type: 'store.changed', storeId: 'a', rev: '2' }))).toBeNull();
		expect(parseEvent(line({ v: 1, type: 'store.changed', rev: 2 }))).toBeNull();
	});

	it('survives anything that is not an event at all', () => {
		for (const raw of ['', 'not json', '[]', 'null', '42', '"x"', undefined, null, 5]) {
			expect(parseEvent(raw), JSON.stringify(raw)).toBeNull();
		}
	});
});
