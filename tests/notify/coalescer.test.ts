/**
 * The notification coalescer — CONTRACT.md §8.8, R-21.
 *
 * `src/lib/server/notify/index.ts` is the whole anti-spam mechanism and it is
 * the only part of notifications that knows about time, so it is the only part
 * whose tests may legitimately fake a clock. Nothing else is faked: there is no
 * database here because the module holds no database handle, and the sink is a
 * real function that records what it was handed.
 *
 * R-21 is covered clause by clause. The clauses that are easy to write code for
 * and hard to get right are the two extension rules: a non-add write EXTENDS an
 * armed batch but never ARMS one, and the extension is clamped so a list
 * somebody keeps touching all evening still notifies.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	MAX_NAMES_PER_BATCH,
	configureNotifier,
	flushNotifications,
	noteItemAdded,
	noteStoreActivity,
	pendingCount,
	resetNotifier,
	setNotificationSink,
	type NotificationBatch
} from '$lib/server/notify';

const QUIET = 5 * 60_000;
const MAX_DELAY = 30 * 60_000;

let batches: NotificationBatch[];

function install(quietMs = QUIET, maxDelayMs = MAX_DELAY) {
	resetNotifier();
	batches = [];
	setNotificationSink((batch) => {
		batches.push(batch);
	});
	configureNotifier({ quietMs, maxDelayMs });
}

beforeEach(() => {
	vi.useFakeTimers();
	install();
});

afterEach(() => {
	resetNotifier();
	vi.useRealTimers();
});

const add = (storeId: string, actorId: string, itemName: string) =>
	noteItemAdded({ storeId, actorId, itemName });

describe('R-21 — the quiet window', () => {
	test('one add fires exactly once, after the quiet window and not before', () => {
		add('s1', 'ayse', 'milk');

		vi.advanceTimersByTime(QUIET - 1);
		expect(batches).toHaveLength(0);

		vi.advanceTimersByTime(1);
		expect(batches).toHaveLength(1);
		expect(batches[0].storeId).toBe('s1');
		expect(batches[0].count).toBe(1);
		expect(batches[0].names).toEqual(['milk']);

		// And it does not fire a second time when more time passes.
		vi.advanceTimersByTime(QUIET * 10);
		expect(batches).toHaveLength(1);
	});

	test('ten adds inside the window fire ONCE, with a count of ten', () => {
		for (let i = 0; i < 10; i += 1) {
			add('s1', 'ayse', `item-${i}`);
			vi.advanceTimersByTime(1000);
		}

		expect(batches).toHaveLength(0);
		vi.advanceTimersByTime(QUIET);

		expect(batches).toHaveLength(1);
		expect(batches[0].count).toBe(10);
	});

	test('the batch carries at most five names but the TRUE count', () => {
		for (let i = 0; i < 11; i += 1) add('s1', 'ayse', `item-${i}`);
		vi.advanceTimersByTime(QUIET);

		expect(MAX_NAMES_PER_BATCH).toBe(5);
		expect(batches[0].names).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
		expect(batches[0].count).toBe(11);
	});

	test('every contributor appears in actorIds, once each', () => {
		add('s1', 'ayse', 'milk');
		add('s1', 'mehmet', 'bread');
		add('s1', 'ayse', 'eggs');
		vi.advanceTimersByTime(QUIET);

		expect([...batches[0].actorIds].sort()).toEqual(['ayse', 'mehmet']);
		expect(batches[0].count).toBe(3);
	});

	test('two stores coalesce independently', () => {
		add('s1', 'ayse', 'milk');
		vi.advanceTimersByTime(QUIET / 2);
		add('s2', 'mehmet', 'aspirin');

		vi.advanceTimersByTime(QUIET / 2);
		expect(batches.map((b) => b.storeId)).toEqual(['s1']);

		vi.advanceTimersByTime(QUIET / 2);
		expect(batches.map((b) => b.storeId)).toEqual(['s1', 's2']);
	});
});

describe('R-21 — extension', () => {
	test('a tick during the window EXTENDS the deadline', () => {
		add('s1', 'ayse', 'milk');

		// One second before the batch would have fired, somebody ticks something.
		vi.advanceTimersByTime(QUIET - 1000);
		noteStoreActivity('s1');

		// The original deadline passes with nothing delivered.
		vi.advanceTimersByTime(1000);
		expect(batches).toHaveLength(0);

		// The new one, a full quiet window after the tick, does deliver.
		vi.advanceTimersByTime(QUIET - 1000);
		expect(batches).toHaveLength(1);
		expect(batches[0].count).toBe(1);
	});

	test('a tick with no armed batch fires nothing and arms nothing', () => {
		noteStoreActivity('s1');
		expect(pendingCount()).toBe(0);

		vi.advanceTimersByTime(MAX_DELAY * 2);
		expect(batches).toHaveLength(0);
	});

	test('the max-delay clamp fires a batch that is being continuously extended', () => {
		add('s1', 'ayse', 'milk');

		// Somebody touches the list every minute, forever. Without the clamp the
		// deadline would be pushed out every time and nothing would ever arrive.
		for (let elapsed = 0; elapsed < MAX_DELAY + QUIET; elapsed += 60_000) {
			vi.advanceTimersByTime(60_000);
			noteStoreActivity('s1');
			if (batches.length > 0) break;
		}

		expect(batches).toHaveLength(1);
		// The clamp is armedAt + maxDelayMs, so it cannot have taken longer.
		expect(Date.now() - batches[0].armedAt).toBeLessThanOrEqual(MAX_DELAY);
		expect(Date.now() - batches[0].armedAt).toBeGreaterThanOrEqual(MAX_DELAY - 60_000);
	});

	test('adds keep accumulating into the clamped batch until it fires', () => {
		add('s1', 'ayse', 'milk');
		for (let elapsed = 0; elapsed < MAX_DELAY; elapsed += 60_000) {
			vi.advanceTimersByTime(60_000);
			if (batches.length > 0) break;
			add('s1', 'mehmet', `item-${elapsed}`);
		}
		expect(batches).toHaveLength(1);
		expect(batches[0].count).toBeGreaterThan(1);
		expect([...batches[0].actorIds].sort()).toEqual(['ayse', 'mehmet']);
	});
});

describe('R-21 — edges', () => {
	test('quietMs: 0 delivers immediately', () => {
		install(0, 60_000);
		add('s1', 'ayse', 'milk');

		// setTimeout(0) still needs the macrotask to run, but no wall clock.
		vi.advanceTimersByTime(0);
		expect(batches).toHaveLength(1);
		expect(batches[0].names).toEqual(['milk']);
	});

	test('flushNotifications delivers everything outstanding', () => {
		add('s1', 'ayse', 'milk');
		add('s2', 'mehmet', 'aspirin');
		expect(batches).toHaveLength(0);
		expect(pendingCount()).toBe(2);

		flushNotifications();

		expect(batches.map((b) => b.storeId).sort()).toEqual(['s1', 's2']);
		expect(pendingCount()).toBe(0);

		// And the cancelled timers do not fire a second copy afterwards.
		vi.advanceTimersByTime(QUIET * 2);
		expect(batches).toHaveLength(2);
	});

	test('flushNotifications with nothing outstanding is a no-op', () => {
		flushNotifications();
		expect(batches).toHaveLength(0);
	});

	test('with no sink installed nothing is even accumulated', () => {
		// This is what ZEMBIL_PUSH_ENABLED=0 produces: not "batches are dropped at
		// delivery" but "batches are never armed", so an off switch costs nothing
		// on the add path.
		resetNotifier();
		configureNotifier({ quietMs: QUIET, maxDelayMs: MAX_DELAY });

		add('s1', 'ayse', 'milk');
		noteStoreActivity('s1');
		expect(pendingCount()).toBe(0);

		vi.advanceTimersByTime(QUIET * 2);
		expect(pendingCount()).toBe(0);
	});

	test('a sink that throws does not escape, and does not wedge later batches', () => {
		resetNotifier();
		configureNotifier({ quietMs: QUIET, maxDelayMs: MAX_DELAY });
		const seen: string[] = [];
		setNotificationSink((batch) => {
			seen.push(batch.storeId);
			throw new Error('sink exploded');
		});

		add('s1', 'ayse', 'milk');
		expect(() => vi.advanceTimersByTime(QUIET)).not.toThrow();
		expect(seen).toEqual(['s1']);

		add('s2', 'ayse', 'bread');
		expect(() => vi.advanceTimersByTime(QUIET)).not.toThrow();
		expect(seen).toEqual(['s1', 's2']);
	});

	test('configureNotifier rejects a maxDelay below the quiet window', () => {
		expect(() => configureNotifier({ quietMs: 60_000, maxDelayMs: 1000 })).toThrow();
		expect(() => configureNotifier({ quietMs: -1, maxDelayMs: 1000 })).toThrow();
	});
});
