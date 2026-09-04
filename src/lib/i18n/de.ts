/**
 * Deutsch.
 *
 * Typed as `Messages`, so a missing key is a compile error (see `en.ts`).
 *
 * German agrees with English on the plural categories that matter here — `one`
 * and `other` — so `plural()` calls carry both forms. Where the English string
 * happens to be identical in both forms, the German is written out twice anyway
 * rather than collapsed to `other`: the two languages agreeing today is not a
 * reason for the catalogue to stop being able to disagree.
 *
 * Formal "Sie" throughout. This is a household app, so "du" is arguably warmer —
 * but it is also the form that reads wrong to exactly one family member, and
 * "Sie" reads merely neutral to everyone.
 */
import { plural } from './plural';
import type { Messages } from './en';

const L = 'de';

export const de: Messages = {
	// ---- shared ---------------------------------------------------------
	retry: 'Erneut versuchen',
	save: 'Speichern',
	saving: 'Wird gespeichert…',
	cancel: 'Abbrechen',
	delete: 'Löschen',
	done: 'Fertig',
	working: 'Einen Moment…',
	errNoSignal: 'Keine Verbindung.',
	errGeneric: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',

	// ---- bottom nav -----------------------------------------------------
	navMain: 'Start',
	navShops: 'Läden',
	navTrips: 'Einkäufe',
	navYou: 'Konto',

	// ---- home -----------------------------------------------------------
	homeEyebrow: 'Unsere Listen',
	homeTitle: 'Läden',
	homeAccount: 'Ihr Konto',
	homeEmptyTitle: 'Noch keine Läden',
	homeEmptyBody:
		'Legen Sie einen an — alles, was Sie dort brauchen, steht auf seiner eigenen Liste.',
	homeAddShop: '+ Laden hinzufügen',
	homeAddItem: 'Etwas hinzufügen',
	homeGone: 'Dieser Laden ist nicht mehr für Sie freigegeben.',
	homeArchivedOpen: 'Archivierte Läden',
	homeArchivedTitle: 'Archivierte Läden',
	homeArchivedEmpty: 'Nichts archiviert.',
	homeArchivedBody:
		'Ein archivierter Laden behält seine Listen. Sie können ihn jederzeit zurückholen.',
	homeRestore: 'Zurückholen',
	homeDeleteShort: 'Löschen',

	// ---- store card -----------------------------------------------------
	cardNothingNeeded: 'Nichts nötig',
	cardToBuy: (n: number) => plural(L, n, { one: `${n} zu kaufen`, other: `${n} zu kaufen` }),
	cardInBasket: (n: number) => plural(L, n, { one: `${n} im Korb`, other: `${n} im Korb` }),
	cardPrivate: 'Nur Sie',
	cardClaimed: (name: string) => `${name} kauft ein`,
	cardArchived: 'Archiviert',

	// ---- quick add ------------------------------------------------------
	addSheetTitle: (store: string) => `Zu ${store} hinzufügen`,
	addSheetTitleAny: 'Zu einem Laden hinzufügen',
	addItemPlaceholder: 'Artikel',
	addNotePlaceholder: 'Menge oder Notiz',
	addSubmit: (store: string) => `Zu ${store} hinzufügen`,
	addSubmitAny: 'Zum Laden hinzufügen',
	addBusy: 'Wird hinzugefügt…',
	addAdded: (name: string) => `„${name}“ hinzugefügt. Noch etwas?`,
	addShopLegend: 'Laden',
	addRecent: 'Kürzlich hier gekauft',
	addDuplicate: (name: string) => `„${name}“ steht bereits auf dieser Liste.`,
	addDuplicateAnyway: 'Trotzdem noch einmal hinzufügen',

	// ---- new shop -------------------------------------------------------
	newShopTitle: 'Laden hinzufügen',
	newShopNamePlaceholder: 'Name des Ladens',
	newShopColour: 'Farbe',
	newShopSubmit: 'Laden anlegen',

	colorTerracotta: 'Terrakotta',
	colorGreen: 'Grün',
	colorViolet: 'Violett',
	colorBlue: 'Blau',
	colorAmber: 'Bernstein',
	colorRose: 'Rosé',
	colorTeal: 'Petrol',
	colorSlate: 'Schiefer',

	// ---- list -----------------------------------------------------------
	listEyebrow: 'Einkauf bei',
	listBack: 'Zurück zu den Läden',
	listEmptyTitle: 'Der Korb ist leer',
	listEmptyBody: 'Fügen Sie das Erste hinzu, was Sie hier brauchen.',
	listDivider: (n: number) => `Im Korb · ${n}`,
	listFinish: (n: number) =>
		plural(L, n, {
			one: `Einkauf beenden · ${n} gekauft`,
			other: `Einkauf beenden · ${n} gekauft`
		}),
	listAddItem: 'Etwas hinzufügen',

	itemSheetTitle: 'Artikel',
	itemInStore: (store: string) => `Bei ${store}`,
	itemAddedBy: (name: string, when: string) => `Hinzugefügt von ${name} · ${when}`,
	rowUndo: 'Rückgängig',
	rowEdit: (name: string) => `${name} bearbeiten`,
	rowCarried: (n: number) =>
		plural(L, n, { one: `${n}-mal übernommen`, other: `${n}-mal übernommen` }),
	rowCarriedNudge: (n: number) =>
		plural(L, n, {
			one: `Nach ${n} Einkauf noch benötigt`,
			other: `Nach ${n} Einkäufen noch benötigt`
		}),

	finishTitle: 'Diesen Einkauf beenden?',
	finishBought: (n: number) =>
		plural(L, n, { one: `${n} Sache gekauft.`, other: `${n} Sachen gekauft.` }),
	finishLeft: (n: number) =>
		plural(L, n, {
			one: `${n} Sache bleibt auf der Liste und wandert auf den nächsten Einkauf hier.`,
			other: `${n} Sachen bleiben auf der Liste und wandern auf den nächsten Einkauf hier.`
		}),
	finishNothingLeft: 'Es bleibt nichts übrig.',
	finishCarriedAgain: (n: number) =>
		plural(L, n, {
			one: `${n} davon wurde schon einmal übernommen.`,
			other: `${n} davon wurden schon einmal übernommen.`
		}),
	finishConfirm: 'Einkauf beenden',
	finishBusy: 'Wird beendet…',
	finishKeep: 'Weiter einkaufen',

	// ---- claims (§8.6) --------------------------------------------------
	claimNobody: 'Es geht noch niemand.',
	claimByMe: 'Sie kaufen hier ein.',
	claimByOther: (name: string) => `${name} kauft hier ein.`,
	claimGo: 'Ich gehe zu diesem Laden',
	claimRelease: 'Ich gehe doch nicht',
	claimTakeOver: 'Übernehmen',
	claimEdit: 'Meine Notiz ändern',
	claimSheetGo: 'Gehen Sie zu diesem Laden?',
	claimSheetEdit: 'Ihre Notiz',
	claimSheetTakeOver: 'Diesen Einkauf übernehmen?',
	claimNotePlaceholder: 'Was holen Sie? (optional)',
	claimNoteLabel: 'Notiz für die Familie',
	claimNoteLeft: (n: number) =>
		plural(L, n, { one: `noch ${n} Zeichen`, other: `noch ${n} Zeichen` }),
	claimSubmit: 'Ich gehe',
	claimSubmitTakeOver: 'Trotzdem übernehmen',
	claimTakeOverHint: 'Beim Übernehmen kaufen Sie ein. Die Notiz der anderen Person wird ersetzt.',

	// ---- store settings / visibility (§8.4) ------------------------------
	storeSettings: 'Ladeneinstellungen',
	storeNameLabel: 'Name des Ladens',
	storeColour: 'Farbe',
	storeVisibility: 'Wer diesen Laden sieht',
	storeVisibilityPublic: 'Alle',
	storeVisibilityPrivate: 'Nur ich',
	storeVisibilityPublicHelp: 'Alle Angemeldeten sehen diesen Laden und seine Liste.',
	storeVisibilityPrivateHelp:
		'Nur Sie sehen diesen Laden, seine Liste und seine Einkäufe — auch Administratoren nicht. Er ist vor ihnen verborgen, nicht verschlüsselt.',
	storeVisibilityLocked:
		'Nur wer diesen Laden angelegt hat oder ein Administrator kann ändern, wer ihn sieht.',
	storePrivateBadge: 'Nur Sie',
	storeArchive: 'Diesen Laden archivieren',
	storeArchiveHelp:
		'Er verschwindet vom Startbildschirm, gelöscht wird nichts. Unter „Archivierte Läden“ holen Sie ihn zurück.',
	storeArchived: 'Archiviert. Zu finden unter „Archivierte Läden“.',

	// ---- Laden löschen (§9.1, R-23) --------------------------------------
	storeDelete: 'Diesen Laden löschen',
	storeDeleteHelp:
		'Der Laden, seine Einkäufe und alle Artikel darauf verschwinden — für alle. Das lässt sich nicht rückgängig machen.',
	storeDeleteConfirm: (name: string) => `${name} endgültig löschen?`,
	storeDeleteCounts: (trips: number, items: number) =>
		`${plural(L, trips, { one: `${trips} Einkauf`, other: `${trips} Einkäufe` })} und ${plural(
			L,
			items,
			{ one: `${items} Artikel`, other: `${items} Artikel` }
		)} wurden mitgelöscht.`,
	storeDeleteSubmit: 'Endgültig löschen',
	storeDeleteKeep: 'Behalten',
	storeDeleting: 'Wird gelöscht…',
	storeDeleted: (name: string) => `${name} wurde gelöscht.`,

	// ---- trips ----------------------------------------------------------
	tripsEyebrow: 'Was wir gekauft haben',
	tripsTitle: 'Einkäufe',
	tripsShop: 'Laden',
	tripsNoShops: 'Noch keine Läden.',
	tripsEmpty: 'Hier gibt es noch keine abgeschlossenen Einkäufe.',
	tripNumber: (seq: number) => `Einkauf ${seq}`,
	tripFinishedBy: (name: string) => `beendet von ${name}`,
	tripShoppedBy: (name: string) => `eingekauft von ${name}`,
	tripBought: (n: number) => plural(L, n, { one: `${n} gekauft`, other: `${n} gekauft` }),
	tripLeft: (n: number) =>
		plural(L, n, {
			one: `${n} blieb auf der Liste`,
			other: `${n} blieben auf der Liste`
		}),
	tripSeeItems: (n: number) =>
		plural(L, n, {
			one: `${n} Artikel ansehen`,
			other: `${n} Artikel ansehen`
		}),
	tripHideItems: 'Artikel ausblenden',
	tripItemLeft: 'übrig',

	// ---- account --------------------------------------------------------
	youTitle: 'Konto',
	youEyebrow: 'Angemeldet als',
	youAdmin: 'Admin',
	youPasskeys: 'Passkeys',
	youPasskeysBody:
		'Melden Sie sich mit Gesicht, Fingerabdruck oder Geräte-PIN an statt mit einem Passwort.',
	youPasskeysNone: 'Für dieses Konto noch keine.',
	youPasskeyUsed: (when: string) => `Verwendet ${when}`,
	youPasskeyRemove: 'Entfernen',
	youPasskeyAdd: 'Passkey hinzufügen',
	youPasskeyUnsupported: 'Dieser Browser kann keine Passkeys verwenden.',
	youPasskeyNameTitle: 'Diesem Gerät einen Namen geben',
	youPasskeyNameLabel: 'Gerätename',
	youPasskeyCreate: 'Passkey erstellen',
	youPasskeyWaiting: 'Warten auf Ihr Gerät…',
	youPasskeyExists: 'Dieses Gerät hat bereits einen Passkey für Ihr Konto.',
	youTheme: 'Design',
	youThemeHelp: 'Wird in Ihrem Konto gespeichert — auf jedem Gerät gleich.',
	youThemeBusy: 'Wird geändert…',
	themeAuto: 'Gerät folgen',
	themeLight: 'Papier',
	themeDark: 'Nacht',
	themeSepia: 'Leinen',
	themeSage: 'Olive',
	themeContrast: 'Hoher Kontrast',
	themeIndigo: 'Indigo',
	themePlum: 'Maulbeere',
	youLanguage: 'Sprache',
	youLanguageBusy: 'Wird geändert…',
	youManage: 'Familie verwalten',
	youVersion: (version: string, date: string) => `Zembil ${version} · Stand ${date}`,
	youSignOut: 'Abmelden',

	// ---- push (§8.7) ----------------------------------------------------
	pushTitle: 'Benachrichtigungen',
	pushBody: 'Ein Hinweis auf diesem Gerät, wenn jemand etwas auf eine geteilte Liste schreibt.',
	pushEnable: 'Auf diesem Gerät einschalten',
	pushDisable: 'Auf diesem Gerät ausschalten',
	pushOn: 'Auf diesem Gerät eingeschaltet.',
	pushOff: 'Auf diesem Gerät ausgeschaltet.',
	pushDevices: (n: number) =>
		plural(L, n, {
			one: `${n} Ihrer Geräte ist angemeldet.`,
			other: `${n} Ihrer Geräte sind angemeldet.`
		}),
	pushDenied:
		'Dieser Browser blockiert Benachrichtigungen. Zembil kann nicht noch einmal fragen — schalten Sie sie in den Browsereinstellungen für diese Seite wieder ein.',
	pushUnsupported: 'Dieser Browser kann keine Benachrichtigungen anzeigen.',
	pushIosHomeScreen:
		'Auf iPhone und iPad müssen Sie Zembil zuerst zum Home-Bildschirm hinzufügen: Safari erlaubt Benachrichtigungen nur für so geöffnete Apps.',
	pushDismissed: 'Jetzt nicht. Sie können sie jederzeit einschalten.',

	// ---- admin ----------------------------------------------------------
	adminTitle: 'Die Familie',
	adminEyebrow: 'Konten',
	adminBack: 'Zurück zu Ihrem Konto',
	adminChip: 'Admin',
	adminDisabled: (when: string) => `Deaktiviert ${when}`,
	adminPasswordOnly: 'Aktiv · nur Passwort',
	adminPasskeys: (n: number) =>
		plural(L, n, {
			one: `Aktiv · ${n} Passkey`,
			other: `Aktiv · ${n} Passkeys`
		}),
	adminReset: 'Passwort zurücksetzen',
	adminRemovePasskeys: 'Passkeys entfernen',
	adminMakeAdmin: 'Zum Admin machen',
	adminUnmakeAdmin: 'Adminrechte entziehen',
	adminDisable: 'Deaktivieren',
	adminEnable: 'Aktivieren',
	adminNew: 'Neue Person',
	adminUsername: 'Benutzername',
	adminDisplayName: 'Name in der App',
	adminCanManage: 'Darf Konten verwalten',
	adminCreate: 'Konto anlegen',
	adminCreating: 'Wird angelegt…',
	adminPasswordTitle: 'Geben Sie ihr dieses Passwort',
	adminPasswordBody: (name: string) =>
		`Es wird nur dieses eine Mal gezeigt — es wird nirgends gespeichert. ${name} muss beim ersten Anmelden ein eigenes Passwort wählen.`,
	adminPasswordCopy: 'Kopieren',
	adminPasswordCopied: 'Kopiert',
	adminPasswordCopyFailed: 'Konnte nicht kopiert werden. Bitte notieren Sie es.',
	adminPasswordDone: 'Ich habe es notiert',

	// ---- sign in --------------------------------------------------------
	loginTitle: 'Willkommen zurück',
	loginName: 'Name',
	loginPassword: 'Passwort',
	loginShow: 'Zeigen',
	loginHide: 'Verbergen',
	loginSubmit: 'Anmelden',
	loginBusy: 'Wird angemeldet…',
	loginPasskey: 'Dieses Telefon kennt Sie',
	loginPasskeyFailed:
		'Dieses Gerät konnte keinen Passkey verwenden. Melden Sie sich mit Ihrem Passwort an.',

	// ---- forced password change -----------------------------------------
	pwTitle: 'Wählen Sie ein Passwort',
	pwBody: (min: number) =>
		`Das erhaltene Passwort ist vorläufig. Wählen Sie etwas, das nur Sie kennen — mindestens ${min} Zeichen.`,
	pwCurrent: 'Vorläufiges Passwort',
	pwNew: 'Neues Passwort',
	pwRepeat: 'Neues Passwort wiederholen',
	pwMore: (n: number) => plural(L, n, { one: `noch ${n} Zeichen.`, other: `noch ${n} Zeichen.` }),
	pwMismatch: 'Die beiden stimmen nicht überein.',
	pwSubmit: 'Speichern und weiter',

	// ---- error page -----------------------------------------------------
	errOfflineTitle: 'Keine Verbindung',
	errNotFound: 'Nicht hier',
	errForbidden: 'Nicht für Sie',
	errUnauthorized: 'Bitte melden Sie sich an',
	errUnknown: 'Etwas ist schiefgelaufen',
	errTryAgain: 'Bitte erneut versuchen.',
	errOfflineBody: 'Zembil braucht das Netz, um Ihre Listen zu zeigen.',
	errSignIn: 'Anmelden',
	errBack: 'Zurück zu den Läden',

	// ---- relative time --------------------------------------------------
	timeNever: 'nie verwendet',
	timeNow: 'gerade eben'
};
