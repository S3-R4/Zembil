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

/**
 * The three interface languages. Stored per USER (`users.locale`), not per
 * device: the server composes push notification text for a recipient who is not
 * the person who triggered it, so it cannot be translated by the client that
 * will display it.
 */
export type Locale = 'en' | 'tr' | 'de';

export const LOCALES: readonly Locale[] = Object.freeze(['en', 'tr', 'de']);

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * The interface theme, stored per USER (`users.theme`) rather than per device.
 *
 * `auto` follows the operating system and is the default; every other value is
 * an explicit choice that wins over it in both directions. The value is a KEY
 * into the token blocks in `app.css`, never a colour — same rule as
 * `stores.color` (D-017).
 *
 * Per user rather than per device (this replaces the old `localStorage`
 * appearance) for two reasons: a member's phone and tablet should not disagree
 * about what their app looks like, and only a value the SERVER holds can reach
 * `<html data-theme>` before the first paint. The previous device-local
 * arrangement is what PROJECT.md §13 listed as the theme-flash gap.
 */
export type Theme = 'auto' | 'light' | 'dark' | 'sepia' | 'sage' | 'contrast' | 'indigo' | 'plum';

/** Picker order: the three that existed first, then light-family, then dark. */
export const THEMES: readonly Theme[] = Object.freeze([
	'auto',
	'light',
	'dark',
	'sepia',
	'sage',
	'contrast',
	'indigo',
	'plum'
]);

export const DEFAULT_THEME: Theme = 'auto';

export interface User {
	id: string;
	username: string;
	displayName: string;
	isAdmin: boolean;
	isActive: boolean;
	mustChangePassword: boolean;
	createdAt: number;
	locale: Locale;
	theme: Theme;
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
	'terracotta' | 'green' | 'violet' | 'blue' | 'amber' | 'rose' | 'teal' | 'slate';

/**
 * `public` — every signed-in member sees the store.
 * `private` — only the one member it belongs to sees it, writes to it, or can
 *   learn that it exists. Admins included; see CONTRACT.md §3.4a.
 */
export type StoreVisibility = 'public' | 'private';

/**
 * Who is shopping this trip right now, and what they said they would pick up.
 *
 * Attached to a TRIP, so it ends when the trip does (R-18). `claimedByMe` is
 * computed per request from the session, because §3 forbids sending a user id
 * to a non-admin — the client needs to know whether the release button is its
 * to press, and the display name is not a safe way to decide that.
 */
export interface Claim {
	claimedByName: string | null;
	claimedByMe: boolean;
	claimedAt: number | null;
	claimNote: string | null;
}

export interface StoreSummary extends Claim {
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
	visibility: StoreVisibility;
	/**
	 * Whether THIS caller may change `visibility` — true for the member who
	 * created the shop and for any admin, false for everybody else. Computed per
	 * request from the session, never a column, and deliberately a boolean rather
	 * than the creator's id: §3 keeps user ids off the wire for non-admins.
	 *
	 * The server enforces the same rule in `updateStore`; this only lets the
	 * interface stop offering a control that would 403.
	 */
	canChangeVisibility: boolean;
}

export type TripStatus = 'open' | 'closed';

export interface Trip extends Claim {
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

/** GET /api/stores/{storeId}/suggestions — CONTRACT §12.1. */
export interface RecentItemSuggestions {
	suggestions: string[];
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

/**
 * Web push — CONTRACT.md §3.9.
 *
 * `PushRegistration` is what the browser's `PushSubscription.toJSON()` gives,
 * narrowed to the two fields the server stores. Nothing here is a secret of
 * ours: `p256dh` and `auth` encrypt a payload TO this browser.
 */
export interface PushRegistration {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** `GET /api/push/key` — the VAPID public key, base64url. Safe to publish. */
export interface PushKeyResponse {
	publicKey: string;
}

/** `GET /api/push/subscription` — is THIS browser registered for THIS member? */
export interface PushStatusResponse {
	subscribed: boolean;
	/** How many of the member's own devices are registered. Never another's. */
	deviceCount: number;
}

/** Realtime hints — CONTRACT.md §4. Hints, never data. */
export type ZembilEvent =
	| { v: 1; type: 'store.changed'; storeId: string; rev: number }
	| { v: 1; type: 'stores.changed' }
	| { v: 1; type: 'session.revoked' };
