/**
 * Türkçe.
 *
 * Typed as `Messages`, so a key missing here is a compile error rather than a
 * screen that quietly falls back to English (see `en.ts` for why there is no
 * runtime fallback).
 *
 * Three things this catalogue does that a literal translation would get wrong:
 *
 *  1. **Counted nouns do not take the plural suffix.** "3 ürün", never
 *     "3 ürünler". Every plural() call here supplies only `other`, which is not
 *     laziness — it is the correct Turkish form for all n.
 *
 *  2. **No suffix is ever glued to a store name.** Turkish vowel harmony would
 *     need "Migros'a" but "BİM'e", and nothing in this codebase can know which.
 *     So every phrase built around a shop name is routed through a fixed word
 *     that takes the suffix instead: "{shop} listesine ekle" — the suffix lands
 *     on *listesine*, which never changes, and the name is left alone. This is
 *     why the Turkish reads slightly longer than the English; it is the only way
 *     to be right for every shop name a family will type.
 *
 *  3. **Personal names are handled the same way.** "{name} alışverişe gidiyor"
 *     puts no suffix on the name.
 */
import { plural } from './plural';
import type { Messages } from './en';

const L = 'tr';

export const tr: Messages = {
	// ---- shared ---------------------------------------------------------
	retry: 'Yeniden dene',
	save: 'Kaydet',
	saving: 'Kaydediliyor…',
	cancel: 'Vazgeç',
	delete: 'Sil',
	done: 'Tamam',
	working: 'Bir saniye…',
	errNoSignal: 'Bağlantı yok.',
	errGeneric: 'Bir şeyler ters gitti. Lütfen tekrar deneyin.',

	// ---- bottom nav -----------------------------------------------------
	navMain: 'Ana sayfa',
	navShops: 'Dükkanlar',
	navTrips: 'Alışverişler',
	navYou: 'Hesabım',

	// ---- home -----------------------------------------------------------
	homeEyebrow: 'Listelerimiz',
	homeTitle: 'Dükkanlar',
	homeAccount: 'Hesabınız',
	homeEmptyTitle: 'Henüz dükkan yok',
	homeEmptyBody: 'Bir tane ekleyin; oradan alacağınız her şey kendi listesinde dursun.',
	homeAddShop: '+ Dükkan ekle',
	homeAddItem: 'Ürün ekle',
	homeGone: 'Bu dükkan artık sizinle paylaşılmıyor.',
	homeArchivedOpen: 'Arşivlenen dükkanlar',
	homeArchivedTitle: 'Arşivlenen dükkanlar',
	homeArchivedEmpty: 'Arşivde bir şey yok.',
	homeArchivedBody: 'Arşivlenen dükkan listelerini korur. İstediğiniz zaman geri getirebilirsiniz.',
	homeRestore: 'Geri getir',
	homeDeleteShort: 'Sil',

	// ---- store card -----------------------------------------------------
	cardNothingNeeded: 'Bir şey gerekmiyor',
	cardToBuy: (n: number) => plural(L, n, { other: `${n} ürün alınacak` }),
	cardInBasket: (n: number) => plural(L, n, { other: `${n} ürün sepette` }),
	cardPrivate: 'Sadece siz',
	cardClaimed: (name: string) => `${name} alışverişe gidiyor`,
	cardArchived: 'Arşivde',

	// ---- quick add ------------------------------------------------------
	addSheetTitle: (store: string) => `${store} listesine ekle`,
	addSheetTitleAny: 'Bir dükkan listesine ekle',
	addItemPlaceholder: 'Ürün',
	addNotePlaceholder: 'Miktar veya not',
	addSubmit: (store: string) => `${store} listesine ekle`,
	addSubmitAny: 'Dükkan listesine ekle',
	addBusy: 'Ekleniyor…',
	addAdded: (name: string) => `“${name}” eklendi. Başka?`,
	addShopLegend: 'Dükkan',

	// ---- new shop -------------------------------------------------------
	newShopTitle: 'Dükkan ekle',
	newShopNamePlaceholder: 'Dükkan adı',
	newShopColour: 'Renk',
	newShopSubmit: 'Dükkanı ekle',

	colorTerracotta: 'Kiremit',
	colorGreen: 'Yeşil',
	colorViolet: 'Mor',
	colorBlue: 'Mavi',
	colorAmber: 'Kehribar',
	colorRose: 'Gül kurusu',
	colorTeal: 'Turkuaz',
	colorSlate: 'Kurşuni',

	// ---- list -----------------------------------------------------------
	listEyebrow: 'Alışveriş',
	listBack: 'Dükkanlara dön',
	listEmptyTitle: 'Sepet boş',
	listEmptyBody: 'Buradan alacağınız ilk şeyi ekleyin.',
	listDivider: (n: number) => `Sepette · ${n}`,
	listFinish: (n: number) => plural(L, n, { other: `Alışverişi bitir · ${n} alındı` }),
	listAddItem: 'Ürün ekle',

	itemSheetTitle: 'Ürün',
	itemInStore: (store: string) => `${store} listesinde`,
	itemAddedBy: (name: string, when: string) => `Ekleyen: ${name} · ${when}`,
	rowUndo: 'Geri al',
	rowEdit: (name: string) => `${name} — düzenle`,
	rowCarried: (n: number) => plural(L, n, { other: `${n} kez devredildi` }),

	finishTitle: 'Bu alışveriş bitsin mi?',
	finishBought: (n: number) => plural(L, n, { other: `${n} ürün alındı.` }),
	finishLeft: (n: number) =>
		plural(L, n, { other: `Listede kalan ${n} ürün buranın sonraki listesine geçecek.` }),
	finishNothingLeft: 'Geride bir şey kalmıyor.',
	finishConfirm: 'Alışverişi bitir',
	finishBusy: 'Bitiriliyor…',
	finishKeep: 'Alışverişe devam',

	// ---- claims (§8.6) --------------------------------------------------
	claimNobody: 'Henüz kimse gitmiyor.',
	claimByMe: 'Bu alışverişe siz gidiyorsunuz.',
	claimByOther: (name: string) => `${name} bu alışverişe gidiyor.`,
	claimGo: 'Bu dükkana ben gidiyorum',
	claimRelease: 'Ben gitmiyorum',
	claimTakeOver: 'Ben devralayım',
	claimEdit: 'Notumu değiştir',
	claimSheetGo: 'Bu dükkana mı gidiyorsunuz?',
	claimSheetEdit: 'Notunuz',
	claimSheetTakeOver: 'Bu alışverişi devralalım mı?',
	claimNotePlaceholder: 'Ne alacaksınız? (isteğe bağlı)',
	claimNoteLabel: 'Aileye not',
	claimNoteLeft: (n: number) => plural(L, n, { other: `${n} karakter kaldı` }),
	claimSubmit: 'Ben gidiyorum',
	claimSubmitTakeOver: 'Yine de devral',
	claimTakeOverHint: 'Devralırsanız alışverişe siz gidiyor olursunuz. Onun notu silinir.',

	// ---- store settings / visibility (§8.4) ------------------------------
	storeSettings: 'Dükkan ayarları',
	storeNameLabel: 'Dükkan adı',
	storeColour: 'Renk',
	storeVisibility: 'Bu dükkanı kimler görsün',
	storeVisibilityPublic: 'Herkes',
	storeVisibilityPrivate: 'Sadece ben',
	storeVisibilityPublicHelp: 'Giriş yapan herkes bu dükkanı ve listesini görür.',
	storeVisibilityPrivateHelp:
		'Bu dükkanı, listesini ve alışverişlerini yalnızca siz görürsünüz — yöneticiler dahil. Onlardan gizlenir, şifrelenmez.',
	storeVisibilityLocked:
		'Bunu kimlerin göreceğini yalnızca dükkanı oluşturan kişi ya da bir yönetici değiştirebilir.',
	storePrivateBadge: 'Sadece siz',
	storeArchive: 'Bu dükkanı arşivle',
	storeArchiveHelp:
		'Ana ekrandan kalkar, hiçbir şey silinmez. “Arşivlenen dükkanlar”dan geri getirebilirsiniz.',
	storeArchived: 'Arşivlendi. “Arşivlenen dükkanlar” içinde.',

	// ---- dükkanı silme (§9.1, R-23) ---------------------------------------
	// Sayılan adlar çoğul eki almaz: “3 alışveriş”, “3 alışverişler” değil.
	// Dükkan adına da hiçbir ek eklenmez; ekler sabit kelimelerin üzerinde kalır.
	storeDelete: 'Bu dükkanı sil',
	storeDeleteHelp:
		'Dükkan, alışverişleri ve içindeki tüm ürünler herkes için silinir. Bu işlem geri alınamaz.',
	storeDeleteConfirm: (name: string) => `${name} kalıcı olarak silinsin mi?`,
	storeDeleteCounts: (trips: number, items: number) =>
		`${plural(L, trips, { other: `${trips} alışveriş` })} ve ${plural(L, items, {
			other: `${items} ürün`
		})} da silindi.`,
	storeDeleteSubmit: 'Kalıcı olarak sil',
	storeDeleteKeep: 'Kalsın',
	storeDeleting: 'Siliniyor…',
	storeDeleted: (name: string) => `${name} silindi.`,

	// ---- trips ----------------------------------------------------------
	tripsEyebrow: 'Neler aldık',
	tripsTitle: 'Alışverişler',
	tripsShop: 'Dükkan',
	tripsNoShops: 'Henüz dükkan yok.',
	tripsEmpty: 'Burada biten alışveriş yok.',
	tripNumber: (seq: number) => `${seq}. alışveriş`,
	tripFinishedBy: (name: string) => `bitiren: ${name}`,
	tripShoppedBy: (name: string) => `alışverişi yapan: ${name}`,
	tripBought: (n: number) => plural(L, n, { other: `${n} ürün alındı` }),
	tripLeft: (n: number) => plural(L, n, { other: `${n} ürün listede kaldı` }),
	tripSeeItems: (n: number) => plural(L, n, { other: `${n} ürünü gör` }),
	tripHideItems: 'Ürünleri gizle',
	tripItemLeft: 'kaldı',

	// ---- account --------------------------------------------------------
	youTitle: 'Hesabım',
	youEyebrow: 'Giriş yapan',
	youAdmin: 'yönetici',
	youPasskeys: 'Geçiş anahtarları',
	youPasskeysBody: 'Parola yerine yüzünüzle, parmak izinizle veya cihaz PIN’inizle girin.',
	youPasskeysNone: 'Bu hesapta henüz yok.',
	youPasskeyUsed: (when: string) => `Kullanıldı: ${when}`,
	youPasskeyRemove: 'Kaldır',
	youPasskeyAdd: 'Geçiş anahtarı ekle',
	youPasskeyUnsupported: 'Bu tarayıcı geçiş anahtarı kullanamıyor.',
	youPasskeyNameTitle: 'Bu cihaza bir ad verin',
	youPasskeyNameLabel: 'Cihaz adı',
	youPasskeyCreate: 'Geçiş anahtarı oluştur',
	youPasskeyWaiting: 'Cihazınız bekleniyor…',
	youPasskeyExists: 'Bu cihazın hesabınız için zaten bir geçiş anahtarı var.',
	youTheme: 'Tema',
	youThemeHelp: 'Hesabınıza kaydedilir; giriş yaptığınız her cihazda aynı görünür.',
	youThemeBusy: 'Değiştiriliyor…',
	themeAuto: 'Cihazımı izle',
	themeLight: 'Kâğıt',
	themeDark: 'Gece',
	themeSepia: 'Keten',
	themeSage: 'Zeytin',
	themeContrast: 'Yüksek kontrast',
	themeIndigo: 'Çivit',
	themePlum: 'Dut',
	youLanguage: 'Dil',
	youLanguageBusy: 'Değiştiriliyor…',
	youManage: 'Aileyi yönet',
	youVersion: (version: string, date: string) => `Zembil ${version} · ${date} itibarıyla`,
	youSignOut: 'Çıkış yap',

	// ---- push (§8.7) ----------------------------------------------------
	pushTitle: 'Bildirimler',
	pushBody: 'Paylaşılan bir listeye bir şey eklendiğinde bu cihaza haber gelsin.',
	pushEnable: 'Bu cihazda aç',
	pushDisable: 'Bu cihazda kapat',
	pushOn: 'Bu cihazda açık.',
	pushOff: 'Bu cihazda kapalı.',
	pushDevices: (n: number) => plural(L, n, { other: `${n} cihazınız kayıtlı.` }),
	pushDenied:
		'Bu tarayıcı bildirimleri engelliyor. Zembil tekrar soramaz — tarayıcı ayarlarından bu site için yeniden açın.',
	pushUnsupported: 'Bu tarayıcı bildirim gösteremiyor.',
	pushIosHomeScreen:
		'iPhone ve iPad’de önce Zembil’i Ana Ekrana ekleyin: Safari yalnızca oradan açılan uygulamalara bildirim izni veriyor.',
	pushDismissed: 'Şimdi değil. İstediğiniz zaman açabilirsiniz.',

	// ---- admin ----------------------------------------------------------
	adminTitle: 'Aile',
	adminEyebrow: 'Hesaplar',
	adminBack: 'Hesabınıza dönün',
	adminChip: 'Yönetici',
	adminDisabled: (when: string) => `Kapatıldı: ${when}`,
	adminPasswordOnly: 'Etkin · yalnızca parola',
	adminPasskeys: (n: number) => plural(L, n, { other: `Etkin · ${n} geçiş anahtarı` }),
	adminReset: 'Parolayı sıfırla',
	adminRemovePasskeys: 'Geçiş anahtarlarını kaldır',
	adminMakeAdmin: 'Yönetici yap',
	adminUnmakeAdmin: 'Yöneticiliği al',
	adminDisable: 'Kapat',
	adminEnable: 'Aç',
	adminNew: 'Yeni kişi',
	adminUsername: 'Kullanıcı adı',
	adminDisplayName: 'Uygulamada görünen ad',
	adminCanManage: 'Hesapları yönetebilir',
	adminCreate: 'Hesabı oluştur',
	adminCreating: 'Oluşturuluyor…',
	adminPasswordTitle: 'Bu parolayı ona verin',
	adminPasswordBody: (name: string) =>
		`Bu parola yalnızca bir kez gösterilir — hiçbir yerde saklanmıyor. ${name} ilk girişinde kendi parolasını seçecek.`,
	adminPasswordCopy: 'Kopyala',
	adminPasswordCopied: 'Kopyalandı',
	adminPasswordCopyFailed: 'Kopyalanamadı. Bir yere not alın.',
	adminPasswordDone: 'Not aldım',

	// ---- sign in --------------------------------------------------------
	loginTitle: 'Tekrar hoş geldiniz',
	loginName: 'Ad',
	loginPassword: 'Parola',
	loginShow: 'Göster',
	loginHide: 'Gizle',
	loginSubmit: 'Giriş yap',
	loginBusy: 'Giriş yapılıyor…',
	loginPasskey: 'Bu telefon sizi hatırlıyor',
	loginPasskeyFailed: 'Bu cihaz geçiş anahtarını kullanamadı. Parolanızla girin.',

	// ---- forced password change -----------------------------------------
	pwTitle: 'Bir parola seçin',
	pwBody: (min: number) =>
		`Size verilen parola geçici. Yalnızca sizin bildiğiniz bir şey seçin — en az ${min} karakter.`,
	pwCurrent: 'Geçici parola',
	pwNew: 'Yeni parola',
	pwRepeat: 'Yeni parolayı tekrar girin',
	pwMore: (n: number) => plural(L, n, { other: `${n} karakter daha.` }),
	pwMismatch: 'Bu ikisi aynı değil.',
	pwSubmit: 'Kaydet ve devam et',

	// ---- error page -----------------------------------------------------
	errOfflineTitle: 'Bağlantı yok',
	errNotFound: 'Burada değil',
	errForbidden: 'Size açık değil',
	errUnauthorized: 'Lütfen giriş yapın',
	errUnknown: 'Bir şeyler ters gitti',
	errTryAgain: 'Lütfen tekrar deneyin.',
	errOfflineBody: 'Zembil listelerinizi göstermek için bağlantıya ihtiyaç duyar.',
	errSignIn: 'Giriş yap',
	errBack: 'Dükkanlara dön',

	// ---- relative time --------------------------------------------------
	timeNever: 'hiç kullanılmadı',
	timeNow: 'az önce'
};
