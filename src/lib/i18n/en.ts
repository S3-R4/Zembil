/**
 * English — the source catalogue.
 *
 * `Messages` is `typeof en`, so `tr.ts` and `de.ts` are STRUCTURALLY forced to
 * carry every key with the same signature: a missing key is a type error, an
 * extra key is a type error, and a plural function that forgot its count is a
 * type error. There is no runtime fallback to English by design — a fallback
 * hides exactly the mistake it is covering for, and a half-translated screen is
 * worse than an untranslated one.
 *
 * Two rules for what belongs here:
 *
 *  1. Only strings the CLIENT authors. Every `{ error: { code, message } }` the
 *     server sends is already written for a person (§3.1) and is shown as-is:
 *     translating it client-side would mean re-inventing it, and a re-invented
 *     "Something went wrong" is what hides `409 STORE_NAME_TAKEN`.
 *  2. Counts go through `plural()`, never `n === 1 ? … : …`. See plural.ts.
 */
import { plural } from './plural';

const L = 'en';

export const en = {
	// ---- shared ---------------------------------------------------------
	retry: 'Retry',
	save: 'Save',
	saving: 'Saving…',
	cancel: 'Cancel',
	delete: 'Delete',
	done: 'Done',
	working: 'Just a moment…',
	/** Only for a request that never reached the server — see api.ts. */
	errNoSignal: 'No signal.',
	/** Only when the server sent no message of its own. */
	errGeneric: 'Something went wrong. Please try again.',

	// ---- bottom nav -----------------------------------------------------
	navMain: 'Main',
	navShops: 'Shops',
	navTrips: 'Trips',
	navYou: 'You',

	// ---- home -----------------------------------------------------------
	homeEyebrow: 'Our lists',
	homeTitle: 'Shops',
	homeAccount: 'Your account',
	homeEmptyTitle: 'No shops yet',
	homeEmptyBody: 'Add one, and everything you need there lives on its own list.',
	homeAddShop: '+ Add a shop',
	homeAddItem: 'Add an item',
	homeGone: 'That shop is not shared with you any more.',
	homeArchivedOpen: 'Archived shops',
	homeArchivedTitle: 'Archived shops',
	homeArchivedEmpty: 'Nothing is archived.',
	homeArchivedBody: 'An archived shop keeps its lists. Bring it back whenever you like.',
	homeRestore: 'Bring back',
	/** The row is narrow; the arming tap gets a full sentence as its aria-label. */
	homeDeleteShort: 'Delete',

	// ---- store card -----------------------------------------------------
	cardNothingNeeded: 'Nothing needed',
	cardToBuy: (n: number) => plural(L, n, { one: `${n} to buy`, other: `${n} to buy` }),
	cardInBasket: (n: number) =>
		plural(L, n, { one: `${n} in the basket`, other: `${n} in the basket` }),
	cardPrivate: 'Only you',
	cardClaimed: (name: string) => `${name} is shopping`,
	cardArchived: 'Archived',

	// ---- quick add ------------------------------------------------------
	addSheetTitle: (store: string) => `Add to ${store}`,
	addSheetTitleAny: 'Add to a shop',
	addItemPlaceholder: 'Item',
	addNotePlaceholder: 'Quantity or note',
	addSubmit: (store: string) => `Add to ${store}`,
	addSubmitAny: 'Add to shop',
	addBusy: 'Adding…',
	addAdded: (name: string) => `Added “${name}”. Next?`,
	addShopLegend: 'Shop',

	// ---- new shop -------------------------------------------------------
	newShopTitle: 'Add a shop',
	newShopNamePlaceholder: 'Shop name',
	newShopColour: 'Colour',
	newShopSubmit: 'Add shop',

	colorTerracotta: 'Terracotta',
	colorGreen: 'Green',
	colorViolet: 'Violet',
	colorBlue: 'Blue',
	colorAmber: 'Amber',
	colorRose: 'Rose',
	colorTeal: 'Teal',
	colorSlate: 'Slate',

	// ---- list -----------------------------------------------------------
	listEyebrow: 'Shopping at',
	listBack: 'Back to shops',
	listEmptyTitle: 'The basket is empty',
	listEmptyBody: 'Add the first thing you need here.',
	listDivider: (n: number) => `In the basket · ${n}`,
	listFinish: (n: number) =>
		plural(L, n, { one: `Finish trip · ${n} bought`, other: `Finish trip · ${n} bought` }),
	listAddItem: 'Add an item',

	itemSheetTitle: 'Item',
	itemInStore: (store: string) => `In ${store}`,
	rowUndo: 'Undo',
	rowEdit: (name: string) => `Edit ${name}`,
	rowCarried: (n: number) =>
		plural(L, n, { one: `Carried over ${n} time`, other: `Carried over ${n} times` }),

	finishTitle: 'Finish this trip?',
	finishBought: (n: number) =>
		plural(L, n, { one: `${n} thing bought.`, other: `${n} things bought.` }),
	finishLeft: (n: number) =>
		plural(L, n, {
			one: `${n} thing still on the list will move to the next trip here.`,
			other: `${n} things still on the list will move to the next trip here.`
		}),
	finishNothingLeft: 'Nothing is left behind.',
	finishConfirm: 'Finish trip',
	finishBusy: 'Finishing…',
	finishKeep: 'Keep shopping',

	// ---- claims (§8.6) --------------------------------------------------
	claimNobody: 'Nobody is going yet.',
	claimByMe: 'You are shopping here.',
	claimByOther: (name: string) => `${name} is shopping here.`,
	claimGo: 'I’m going to this shop',
	claimRelease: 'I’m not going',
	claimTakeOver: 'Take over',
	claimEdit: 'Change my note',
	claimSheetGo: 'Going to this shop?',
	claimSheetEdit: 'Your note',
	claimSheetTakeOver: 'Take over this trip?',
	claimNotePlaceholder: 'What are you picking up? (optional)',
	claimNoteLabel: 'Note for the family',
	claimNoteLeft: (n: number) =>
		plural(L, n, { one: `${n} character left`, other: `${n} characters left` }),
	claimSubmit: 'I’m going',
	claimSubmitTakeOver: 'Take over anyway',
	claimTakeOverHint: 'Taking over makes you the one shopping. Their note is replaced.',

	// ---- store settings / visibility (§8.4) ------------------------------
	storeSettings: 'Shop settings',
	storeNameLabel: 'Shop name',
	storeColour: 'Colour',
	storeVisibility: 'Who can see this shop',
	storeVisibilityPublic: 'Everyone',
	storeVisibilityPrivate: 'Only me',
	storeVisibilityPublicHelp: 'Everyone signed in sees this shop and its list.',
	storeVisibilityPrivateHelp:
		'Only you can see this shop, its list and its trips — admins included. It is hidden from them, not encrypted.',
	storeVisibilityLocked:
		'Only the member who created this shop, or an admin, can change who sees it.',
	storePrivateBadge: 'Only you',
	storeArchive: 'Archive this shop',
	storeArchiveHelp:
		'It leaves the home screen and nothing is deleted. Bring it back from Archived shops.',
	storeArchived: 'Archived. It is under “Archived shops”.',

	// ---- deleting a shop (§9.1, R-23) ------------------------------------
	// The words do the safety work. “Archive” and “Delete” sit in the same sheet,
	// so the copy on each has to make the difference obvious BEFORE the tap:
	// archiving says nothing is deleted; deleting names what goes and says it
	// does not come back.
	storeDelete: 'Delete this shop',
	storeDeleteHelp:
		'The shop, its trips and every item on them go, for everyone. This cannot be undone.',
	storeDeleteConfirm: (name: string) => `Delete ${name} for good?`,
	storeDeleteCounts: (trips: number, items: number) =>
		`${plural(L, trips, { one: `${trips} trip`, other: `${trips} trips` })} and ${plural(L, items, {
			one: `${items} item`,
			other: `${items} items`
		})} went with it.`,
	storeDeleteSubmit: 'Delete permanently',
	storeDeleteKeep: 'Keep it',
	storeDeleting: 'Deleting…',
	storeDeleted: (name: string) => `${name} was deleted.`,

	// ---- trips ----------------------------------------------------------
	tripsEyebrow: 'What we bought',
	tripsTitle: 'Trips',
	tripsShop: 'Shop',
	tripsNoShops: 'No shops yet.',
	tripsEmpty: 'No finished trips here yet.',
	tripNumber: (seq: number) => `Trip ${seq}`,
	tripFinishedBy: (name: string) => `finished by ${name}`,
	tripShoppedBy: (name: string) => `picked up by ${name}`,
	tripBought: (n: number) => plural(L, n, { one: `${n} bought`, other: `${n} bought` }),
	tripLeft: (n: number) =>
		plural(L, n, { one: `${n} left on the list`, other: `${n} left on the list` }),
	tripSeeItems: (n: number) =>
		plural(L, n, { one: `See ${n} item`, other: `See ${n} items` }),
	tripHideItems: 'Hide items',
	tripItemLeft: 'left',

	// ---- account --------------------------------------------------------
	youTitle: 'You',
	youEyebrow: 'Signed in as',
	youAdmin: 'admin',
	youPasskeys: 'Passkeys',
	youPasskeysBody: 'Sign in with your face, fingerprint or device PIN instead of a password.',
	youPasskeysNone: 'None on this account yet.',
	youPasskeyUsed: (when: string) => `Used ${when}`,
	youPasskeyRemove: 'Remove',
	youPasskeyAdd: 'Add a passkey',
	youPasskeyUnsupported: 'This browser cannot use passkeys.',
	youPasskeyNameTitle: 'Name this device',
	youPasskeyNameLabel: 'Device name',
	youPasskeyCreate: 'Create passkey',
	youPasskeyWaiting: 'Waiting for your device…',
	youPasskeyExists: 'This device already has a passkey for your account.',
	youTheme: 'Theme',
	youThemeHelp: 'Saved to your account, so every device you sign in on looks the same.',
	youThemeBusy: 'Changing…',
	themeAuto: 'Follow my device',
	themeLight: 'Paper',
	themeDark: 'Night',
	themeSepia: 'Linen',
	themeSage: 'Olive',
	themeContrast: 'High contrast',
	themeIndigo: 'Indigo',
	themePlum: 'Mulberry',
	youLanguage: 'Language',
	youLanguageBusy: 'Changing…',
	youManage: 'Manage the family',
	/** M9. `version` arrives as "v0.8", `date` already formatted in this locale. */
	youVersion: (version: string, date: string) => `Zembil ${version} · as of ${date}`,
	youSignOut: 'Sign out',

	// ---- push (§8.7) ----------------------------------------------------
	pushTitle: 'Notifications',
	pushBody: 'A nudge on this device when someone adds something to a shared list.',
	pushEnable: 'Turn on for this device',
	pushDisable: 'Turn off on this device',
	pushOn: 'On for this device.',
	pushOff: 'Off on this device.',
	pushDevices: (n: number) =>
		plural(L, n, {
			one: `${n} of your devices is signed up.`,
			other: `${n} of your devices are signed up.`
		}),
	pushDenied:
		'This browser is blocking notifications. Zembil cannot ask again — turn them back on for this site in your browser settings.',
	pushUnsupported: 'This browser cannot show notifications.',
	pushIosHomeScreen:
		'On iPhone and iPad, add Zembil to your Home Screen first: Safari only allows notifications for apps opened from there.',
	pushDismissed: 'Not now. You can turn them on whenever you like.',

	// ---- admin ----------------------------------------------------------
	adminTitle: 'The family',
	adminEyebrow: 'Accounts',
	adminBack: 'Back to your account',
	adminChip: 'Admin',
	adminDisabled: (when: string) => `Disabled ${when}`,
	adminPasswordOnly: 'Active · password only',
	adminPasskeys: (n: number) =>
		plural(L, n, { one: `Active · ${n} passkey`, other: `Active · ${n} passkeys` }),
	adminReset: 'Reset password',
	adminRemovePasskeys: 'Remove passkeys',
	adminMakeAdmin: 'Make admin',
	adminUnmakeAdmin: 'Remove admin',
	adminDisable: 'Disable',
	adminEnable: 'Enable',
	adminNew: 'New person',
	adminUsername: 'Username',
	adminDisplayName: 'Name shown in the app',
	adminCanManage: 'Can manage accounts',
	adminCreate: 'Create account',
	adminCreating: 'Creating…',
	adminPasswordTitle: 'Give them this password',
	adminPasswordBody: (name: string) =>
		`This is the only time it will ever be shown — it is not stored anywhere. ${name} will have to choose their own password the first time they sign in.`,
	adminPasswordCopy: 'Copy',
	adminPasswordCopied: 'Copied',
	adminPasswordCopyFailed: 'Could not copy it. Write it down instead.',
	adminPasswordDone: 'I have written it down',

	// ---- sign in --------------------------------------------------------
	loginTitle: 'Welcome back',
	loginName: 'Name',
	loginPassword: 'Password',
	loginShow: 'Show',
	loginHide: 'Hide',
	loginSubmit: 'Sign in',
	loginBusy: 'Signing in…',
	loginPasskey: 'This phone remembers you',
	loginPasskeyFailed: 'This device could not use a passkey. Sign in with your password.',

	// ---- forced password change -----------------------------------------
	pwTitle: 'Choose a password',
	pwBody: (min: number) =>
		`The one you were given is temporary. Pick something only you know — at least ${min} characters.`,
	pwCurrent: 'Temporary password',
	pwNew: 'New password',
	pwRepeat: 'Repeat new password',
	pwMore: (n: number) => plural(L, n, { one: `${n} more to go.`, other: `${n} more to go.` }),
	pwMismatch: 'Those two do not match.',
	pwSubmit: 'Save and continue',

	// ---- error page -----------------------------------------------------
	errOfflineTitle: 'No signal',
	errNotFound: 'Not here',
	errForbidden: 'Not for you',
	errUnauthorized: 'Please sign in',
	errUnknown: 'Something went wrong',
	errTryAgain: 'Please try again.',
	errOfflineBody: 'Zembil needs the network to show your lists.',
	errSignIn: 'Sign in',
	errBack: 'Back to shops',

	// ---- relative time (client-authored halves of Intl output) ----------
	timeNever: 'never used',
	timeNow: 'just now'
};

export type Messages = typeof en;
