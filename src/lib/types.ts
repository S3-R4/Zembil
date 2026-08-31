/**
 * Shared domain types — CONTRACT.md §7.
 *
 * This is the single definition of every shape that crosses the client/server
 * boundary. The frontend imports from here and does not redeclare them.
 *
 * `App.Locals` is specified in §7 too, but it is *declared* in `src/app.d.ts`,
 * which zembil-auth owns. Declaring it here as well would be a duplicate
 * ambient declaration. Its normative shape is:
 *
 *   interface Locals { user: User | null; sessionId: string | null; }
 */

export interface User {
	id: string;
	username: string;
	displayName: string;
	isAdmin: boolean;
	isActive: boolean;
	mustChangePassword: boolean;
	createdAt: number;
}

/** Admin listing only — never sent to a non-admin. */
export interface AdminUser extends User {
	passkeyCount: number;
	disabledAt: number | null;
	mustChangePassword: boolean;
	lastSeenAt: number | null;
}

export interface Passkey {
	id: string;
	deviceLabel: string;
	createdAt: number;
	lastUsedAt: number | null;
	backedUp: boolean;
}

export type StoreColor =
	| 'terracotta'
	| 'green'
	| 'violet'
	| 'blue'
	| 'amber'
	| 'rose'
	| 'teal'
	| 'slate';

export interface StoreSummary {
	id: string;
	name: string;
	color: StoreColor;
	sortOrder: number;
	rev: number;
	openTripId: string;
	pendingCount: number;
	tickedCount: number;
	lastClosedTripAt: number | null;
	archivedAt: number | null; // non-null only in the ?includeArchived=true listing
}

export type TripStatus = 'open' | 'closed';

export interface Trip {
	id: string;
	storeId: string;
	seq: number;
	status: TripStatus;
	openedAt: number;
	closedAt: number | null;
	closedByName: string | null;
}

export interface TripSummary extends Trip {
	boughtCount: number;
	carriedCount: number;
}

export type ItemState = 'pending' | 'ticked' | 'carried';

export interface Item {
	id: string;
	tripId: string;
	storeId: string;
	name: string;
	note: string | null;
	state: ItemState;
	sortOrder: number;
	tickedAt: number | null;
	tickedByName: string | null; // display name, never the user id — no id leakage to the client
	carryCount: number;
	version: number;
	createdAt: number;
	createdByName: string | null;
}

export interface ApiError {
	error: { code: string; message: string };
}

/** The only error responses with a named sibling field — see §3.1 / §3.4. */
export interface VersionConflictError extends ApiError {
	item: Item;
}
export interface TripAlreadyClosedError extends ApiError {
	openTripId: string;
}
export interface StoreNameTakenError extends ApiError {
	storeId: string;
}

/** Every item-mutating endpoint returns this — see §3.5. `rev` is the store's
 *  rev AFTER the write, and is what lets a client suppress its own echo. */
export interface ItemMutation {
	item: Item;
	rev: number;
}

/** Realtime hints — CONTRACT.md §4. Hints, never data. */
export type ZembilEvent =
	| { v: 1; type: 'store.changed'; storeId: string; rev: number }
	| { v: 1; type: 'stores.changed' }
	| { v: 1; type: 'session.revoked' };
