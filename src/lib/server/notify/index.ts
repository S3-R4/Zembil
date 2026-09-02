/**
 * The notification coalescer — CONTRACT.md §3.9, R-21.
 *
 * This module is the whole anti-spam mechanism, and it is deliberately the only
 * part of notifications that knows about time. It holds NO database handle, does
 * NO I/O, and sends nothing: it accumulates what changed and, once a store's
 * list has stopped changing, hands one batch to a sink. `hooks.server.ts`
 * installs the push sink at startup; a test installs a recording one.
 *
 * The rule, stated once (R-21):
 *
 *   An added item arms a batch for its store. Every further write to that store —
 *   another add, a tick, an edit, a delete, a claim, a close — pushes the batch's
 *   deadline out by the quiet window again. When the store finally goes quiet for
 *   a whole window, ONE notification goes out describing everything that was
 *   added. `ZEMBIL_NOTIFY_MAX_DELAY_MINUTES` caps how far the deadline can be
 *   pushed from when the batch was armed, so a list somebody keeps touching all
 *   evening still notifies rather than never notifying.
 *
 * Why trailing rather than leading: the interesting message is "Migros: milk,
 * bread and 4 more", which does not exist until the person has finished typing.
 * A leading edge would send "Migros: milk" and then swallow the rest, which is
 * the opposite of useful — it is the same buzz with less information.
 *
 * State is in memory and does not survive a restart, exactly like the rate-limit
 * buckets (D-007). A restart inside a quiet window drops that batch. Persisting
 * it would mean writing a row per add on the hot path to protect a notification
 * nobody is waiting on yet.
 */

/** Item names carried in the batch. Beyond this the batch reports a count. */
export const MAX_NAMES_PER_BATCH = 5;

export interface AddedItem {
	storeId: string;
	/** The member who added it. Recipients are everyone EXCEPT the contributors. */
	actorId: string;
	itemName: string;
}

/** What the sink receives. Ids only — the sink resolves names from the database
 *  at delivery time, so a store renamed during the window notifies under its
 *  current name. */
export interface NotificationBatch {
	storeId: string;
	/** When the first unnotified add landed. */
	armedAt: number;
	/** Total items added during the window, including those beyond `names`. */
	count: number;
	/** Up to MAX_NAMES_PER_BATCH names, in the order they were added. */
	names: string[];
	/** Everyone who added something. None of them is notified about it. */
	actorIds: string[];
}

export type NotificationSink = (batch: NotificationBatch) => void | Promise<void>;

interface Pending {
	storeId: string;
	armedAt: number;
	count: number;
	names: string[];
	actorIds: Set<string>;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface NotifierOptions {
	quietMs: number;
	maxDelayMs: number;
}

const pending = new Map<string, Pending>();
let sink: NotificationSink | null = null;
let options: NotifierOptions = { quietMs: 5 * 60_000, maxDelayMs: 30 * 60_000 };

/** Installed once at startup by `hooks.server.ts`. `null` disables delivery,
 *  which is what `ZEMBIL_PUSH_ENABLED=0` produces — batches are then never
 *  armed at all, so nothing accumulates. */
export function setNotificationSink(next: NotificationSink | null): void {
	sink = next;
}

export function configureNotifier(next: NotifierOptions): void {
	if (!Number.isSafeInteger(next.quietMs) || next.quietMs < 0) {
		throw new Error(`Invalid quietMs: ${next.quietMs}`);
	}
	if (!Number.isSafeInteger(next.maxDelayMs) || next.maxDelayMs < next.quietMs) {
		throw new Error(`Invalid maxDelayMs: ${next.maxDelayMs}`);
	}
	options = next;
}

function fire(storeId: string): void {
	const batch = pending.get(storeId);
	if (!batch) return;
	pending.delete(storeId);
	if (batch.timer !== null) clearTimeout(batch.timer);

	const current = sink;
	if (!current) return;
	try {
		// Fire and forget: a notification that fails must never surface as an
		// error on a shopping list. The sink logs its own failures.
		void Promise.resolve(
			current({
				storeId: batch.storeId,
				armedAt: batch.armedAt,
				count: batch.count,
				names: batch.names,
				actorIds: [...batch.actorIds]
			})
		).catch((err) => {
			console.error('[zembil] notification sink failed', err);
		});
	} catch (err) {
		console.error('[zembil] notification sink threw synchronously', err);
	}
}

/**
 * (Re)arms the timer for a batch that already exists.
 *
 * The deadline is `now + quietMs`, clamped so it never exceeds
 * `armedAt + maxDelayMs`. The clamp is what stops an active list from starving
 * its own notification: without it, one member adding something every four
 * minutes for two hours produces no notification for two hours.
 */
function reschedule(batch: Pending, now: number): void {
	if (batch.timer !== null) clearTimeout(batch.timer);
	const deadline = Math.min(now + options.quietMs, batch.armedAt + options.maxDelayMs);
	const delay = Math.max(0, deadline - now);
	const timer = setTimeout(() => fire(batch.storeId), delay);
	// A pending notification must never be the reason the process stays alive.
	// A restart inside a quiet window drops that batch; see `flushNotifications`.
	if (typeof timer.unref === 'function') timer.unref();
	batch.timer = timer;
}

/**
 * Called after the add transaction commits, next to `emitStoreChanged`.
 * Never throws — a broken notifier must not fail the write that triggered it.
 */
export function noteItemAdded(added: AddedItem): void {
	if (!sink) return;
	try {
		const now = Date.now();
		let batch = pending.get(added.storeId);
		if (!batch) {
			batch = {
				storeId: added.storeId,
				armedAt: now,
				count: 0,
				names: [],
				actorIds: new Set(),
				timer: null
			};
			pending.set(added.storeId, batch);
		}
		batch.count += 1;
		if (batch.names.length < MAX_NAMES_PER_BATCH) batch.names.push(added.itemName);
		batch.actorIds.add(added.actorId);
		reschedule(batch, now);
	} catch (err) {
		console.error('[zembil] noteItemAdded failed', err);
	}
}

/**
 * Any other write to a store: tick, untick, edit, delete, claim, release, close.
 *
 * Only ever EXTENDS an existing batch's quiet window — it never arms one,
 * because R-21 notifies about things being added, not about things happening.
 * Ticking every row on a list nobody added to today sends nothing.
 */
export function noteStoreActivity(storeId: string): void {
	if (!sink) return;
	try {
		const batch = pending.get(storeId);
		if (!batch) return;
		reschedule(batch, Date.now());
	} catch (err) {
		console.error('[zembil] noteStoreActivity failed', err);
	}
}

/**
 * Delivers every outstanding batch immediately.
 *
 * This is a TEST SEAM, and it is deliberately NOT wired into §3.8's graceful
 * shutdown. `shutdown()` calls `process.exit(0)` synchronously after closing the
 * database; delivery is an HTTPS round trip to a push service, so flushing there
 * would start requests the process is about to abandon and log their failures on
 * the way out. Pretending to flush is worse than not flushing: a batch dropped by
 * a restart is one missed notification, and the next add re-arms one.
 */
export function flushNotifications(): void {
	for (const storeId of [...pending.keys()]) fire(storeId);
}

/** Introspection for tests. Not part of the §3.9 surface. */
export function pendingCount(): number {
	return pending.size;
}

/** Test helper: drop everything without delivering. */
export function resetNotifier(): void {
	for (const batch of pending.values()) {
		if (batch.timer !== null) clearTimeout(batch.timer);
	}
	pending.clear();
	sink = null;
	options = { quietMs: 5 * 60_000, maxDelayMs: 30 * 60_000 };
}
