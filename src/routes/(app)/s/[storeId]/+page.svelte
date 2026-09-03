<!--
  One store's open list — docs/DESIGN.md §4, CONTRACT.md §3.5.

  Adding an item is the most frequent action in the app, so it costs one tap
  from this screen and the sheet STAYS OPEN afterwards: the second item should
  cost one tap, not four.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import type { Item, StoreColor } from '$lib/types';
	import { untrack } from 'svelte';
	import { listFor, messageOf, shops, sortItems } from '$lib/client/app.svelte';
	import { ApiError, newClientId } from '$lib/client/api';
	import { messages } from '$lib/client/i18n';
	import { STORE_COLORS } from '$lib/client/palette';
	import { relative } from '$lib/client/time';
	import Banner from '$lib/components/Banner.svelte';
	import ItemRow from '$lib/components/ItemRow.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { data } = $props();

	const m = $derived(messages());

	let list = $derived(listFor(data.store.id));

	// As on the home screen: render from the load payload until the store has
	// been seeded, because effects do not run during SSR. `seed()` refuses a
	// payload older than what it already holds, so calling it on every navigation
	// is safe and is what repairs a list that missed an event while the stream
	// was down.
	let store = $derived(list.loaded ? list.store : data.store);
	let items = $derived(list.loaded ? list.items : sortItems(data.items));
	let pending = $derived(items.filter((i) => i.state === 'pending'));
	let ticked = $derived(items.filter((i) => i.state === 'ticked'));

	// `untrack`, because `seed()` READS the state it writes — `loaded`, `rev`,
	// and the in-flight rows it preserves. Without it the effect depends on its
	// own output and Svelte stops the page with effect_update_depth_exceeded.
	// The dependency that matters is `data`, and only `data`.
	$effect(() => {
		const payload = data;
		untrack(() => listFor(payload.store.id).seed(payload));
	});

	// ---- quick add --------------------------------------------------------
	let adding = $state(false);
	let draftName = $state('');
	let draftNote = $state('');
	let addBusy = $state(false);
	let addError = $state<string | null>(null);
	let justAdded = $state<string | null>(null);
	let nameInput = $state<HTMLInputElement | null>(null);
	// §3.5 / R-17: one clientId per compose, reused across every retry of THAT
	// compose, fresh only for a new item. `failedFor` is what makes "that
	// compose" precise — see submitAdd.
	let clientId = $state(newClientId());
	let failedFor = $state<string | null>(null);

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		const name = draftName.trim();
		if (addBusy || name.length === 0) return;
		// A previous attempt failed and the member has since typed something else.
		// That is a NEW item, not a retry: reusing the old clientId would make the
		// server answer 200 with the item the earlier attempt actually committed —
		// R-17 working exactly as designed, on a request that no longer means what
		// it did.
		if (failedFor !== null && failedFor !== name) {
			clientId = newClientId();
			failedFor = null;
		}
		addBusy = true;
		addError = null;
		try {
			const added = await list.add(name, draftNote.trim() || null, clientId);
			// The server's name, not the typed one. On an idempotent hit the server
			// returns the item it already had, which may not be what was just typed.
			justAdded = added.name;
			draftName = '';
			draftNote = '';
			clientId = newClientId();
			failedFor = null;
			// The sheet stays open and the caret goes back to the name field. This
			// is the whole point of the sheet.
			nameInput?.focus();
			void shops.load();
		} catch (err) {
			// The clientId is deliberately NOT regenerated: while the text is
			// unchanged this is still the same compose, and the next attempt must be
			// the same idempotent request.
			failedFor = name;
			addError = messageOf(err);
		} finally {
			addBusy = false;
		}
	}

	function openAdd() {
		addError = null;
		justAdded = null;
		adding = true;
	}

	// ---- item detail ------------------------------------------------------
	let editing = $state<Item | null>(null);
	let editName = $state('');
	let editNote = $state('');
	let editBusy = $state(false);
	let editError = $state<string | null>(null);

	function openItem(item: Item) {
		editing = item;
		editName = item.name;
		editNote = item.note ?? '';
		editError = null;
	}

	async function saveItem(event: SubmitEvent) {
		event.preventDefault();
		const item = editing;
		if (!item || editBusy || editName.trim().length === 0) return;
		editBusy = true;
		editError = null;
		try {
			await list.edit(item, editName.trim(), editNote.trim() || null);
			editing = null;
		} catch (err) {
			editError = messageOf(err);
			// §7: a VERSION_CONFLICT carries the current item, and the list refetch
			// is what gets the sheet a version it can save against.
			await list.load();
		} finally {
			editBusy = false;
		}
	}

	async function deleteItem() {
		const item = editing;
		if (!item || editBusy) return;
		editBusy = true;
		editError = null;
		try {
			await list.remove(item);
			editing = null;
			void shops.load();
		} catch (err) {
			editError = messageOf(err);
		} finally {
			editBusy = false;
		}
	}

	// ---- finish trip ------------------------------------------------------
	let finishing = $state(false);
	let finishBusy = $state(false);
	let finishError = $state<string | null>(null);

	async function finishTrip() {
		if (finishBusy) return;
		finishBusy = true;
		finishError = null;
		try {
			await list.close();
			finishing = false;
			await goto('/trips');
		} catch (err) {
			finishError = messageOf(err);
		} finally {
			finishBusy = false;
		}
	}

	// ---- claim (§8.6, R-18 … R-20) -----------------------------------------
	let claiming = $state(false);
	let claimNote = $state('');
	let claimBusy = $state(false);
	let claimError = $state<string | null>(null);
	/** Set when the server answered 409 TRIP_CLAIMED. The sheet then offers
	 *  "take over anyway", which is the whole point of the feature — the member
	 *  must not have to go looking for it. */
	let claimConflict = $state(false);

	const CLAIM_NOTE_MAX = 140;
	let claimNoteLeft = $derived(CLAIM_NOTE_MAX - claimNote.length);

	function openClaim() {
		// Editing my own note starts from what I wrote; claiming afresh starts
		// empty rather than from someone else's words.
		claimNote = store?.claimedByMe ? (store.claimNote ?? '') : '';
		claimError = null;
		claimConflict = false;
		claiming = true;
	}

	async function submitClaim(takeover: boolean) {
		if (claimBusy) return;
		claimBusy = true;
		claimError = null;
		try {
			await list.claim(claimNote.trim() || null, takeover);
			claiming = false;
			claimConflict = false;
		} catch (err) {
			// R-19: the message names the holder, so it is shown as-is (§3.1) and
			// the button below it becomes "take over anyway".
			if (err instanceof ApiError && err.code === 'TRIP_CLAIMED') claimConflict = true;
			if (err instanceof ApiError && err.code === 'TRIP_ALREADY_CLOSED') await list.load();
			claimError = messageOf(err);
		} finally {
			claimBusy = false;
		}
	}

	async function releaseClaim() {
		if (claimBusy) return;
		claimBusy = true;
		claimError = null;
		try {
			await list.releaseClaim();
			claiming = false;
		} catch (err) {
			claimError = messageOf(err);
		} finally {
			claimBusy = false;
		}
	}

	// ---- shop settings (§8.4, R-14, R-22) -----------------------------------
	let settingsOpen = $state(false);
	let settingsName = $state('');
	let settingsColor = $state<StoreColor>('terracotta');
	let settingsBusy = $state(false);
	let settingsError = $state<string | null>(null);

	function openSettings() {
		settingsName = store?.name ?? '';
		settingsColor = (store?.color ?? 'terracotta') as StoreColor;
		settingsError = null;
		// Never reopen already-armed. A confirm step that survives a close is a
		// delete one tap away from a member who came back to rename something.
		confirmingDelete = false;
		settingsOpen = true;
	}

	async function runSettings(fn: () => Promise<unknown>) {
		if (settingsBusy) return false;
		settingsBusy = true;
		settingsError = null;
		try {
			await fn();
			return true;
		} catch (err) {
			settingsError = messageOf(err);
			return false;
		} finally {
			settingsBusy = false;
		}
	}

	async function saveSettings(event: SubmitEvent) {
		event.preventDefault();
		const name = settingsName.trim();
		if (name.length === 0 || !store) return;
		const ok = await runSettings(async () => {
			await shops.patch(store.id, { name, color: settingsColor });
			await list.load();
		});
		if (ok) settingsOpen = false;
	}

	/**
	 * R-22. Going private removes this shop from everyone else's world in one
	 * step — it leaves their home screen and their `/s/{id}` starts returning a
	 * 404 indistinguishable from a shop that never existed.
	 */
	async function setVisibility(visibility: 'public' | 'private') {
		if (!store || store.visibility === visibility) return;
		await runSettings(async () => {
			await shops.patch(store.id, { visibility });
			await list.load();
		});
	}

	async function archiveStore() {
		if (!store) return;
		const ok = await runSettings(() => shops.patch(store.id, { archived: true }));
		if (ok) {
			settingsOpen = false;
			await goto('/');
		}
	}

	/**
	 * §9.1 / R-23. Two taps, and the second one is a different button with
	 * different words on it — the destructive action is never the one already
	 * under the thumb. There is no `confirm()`: it is unstyled, untranslated, and
	 * on iOS it is a system sheet over a bottom sheet.
	 */
	let confirmingDelete = $state(false);

	async function deleteStore() {
		if (!store) return;
		const ok = await runSettings(() => shops.remove(store.id));
		if (ok) {
			confirmingDelete = false;
			settingsOpen = false;
			// Home reads `shops.lastDeleted` and says what went. Nothing here can
			// say it: this screen is about to 404.
			await goto('/');
		}
	}

	let boughtCount = $derived(ticked.length);
	let leftCount = $derived(pending.length);

	/** The claim line under the title. `claimedByName` is a display name; §8.6
	 *  adds `claimedByMe` precisely because two members can share one. */
	let claimLine = $derived(
		!store?.claimedByName
			? m.claimNobody
			: store.claimedByMe
				? m.claimByMe
				: m.claimByOther(store.claimedByName)
	);
</script>

<svelte:head><title>{store?.name ?? 'Zembil'} · Zembil</title></svelte:head>

<header data-color={store?.color}>
	<a class="back" href="/" aria-label={m.listBack}>
		<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
			<path
				d="M15 5 8 12l7 7"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</a>
	<div class="titles">
		<p class="z-eyebrow">{m.listEyebrow}</p>
		<h1 class="z-title">
			{store?.name ?? ''}
			{#if store?.visibility === 'private'}
				<span class="z-chip private">{m.storePrivateBadge}</span>
			{/if}
		</h1>
	</div>
	<button class="gear" type="button" onclick={openSettings} aria-label={m.storeSettings}>
		<!--
			A cog, not a sun. The first pass drew a circle with eight straight rays,
			which reads as brightness — the icon next to it on most phones is the
			display setting. The toothed ring is what says "settings" at 22px.
		-->
		<svg
			viewBox="0 0 24 24"
			width="22"
			height="22"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="3.1" />
			<path
				d="M19.05 14.6a1.5 1.5 0 0 0 .3 1.66l.05.05a1.82 1.82 0 1 1-2.58 2.58l-.05-.05a1.5 1.5 0 0 0-1.66-.3 1.5 1.5 0 0 0-.91 1.38v.15a1.82 1.82 0 1 1-3.64 0v-.08a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.66.3l-.05.05a1.82 1.82 0 1 1-2.58-2.58l.05-.05a1.5 1.5 0 0 0 .3-1.66 1.5 1.5 0 0 0-1.37-.91h-.15a1.82 1.82 0 1 1 0-3.64h.08a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.66l-.05-.05a1.82 1.82 0 1 1 2.58-2.58l.05.05a1.5 1.5 0 0 0 1.66.3h.07a1.5 1.5 0 0 0 .91-1.37v-.15a1.82 1.82 0 1 1 3.64 0v.08a1.5 1.5 0 0 0 .91 1.37 1.5 1.5 0 0 0 1.66-.3l.05-.05a1.82 1.82 0 1 1 2.58 2.58l-.05.05a1.5 1.5 0 0 0-.3 1.66v.07a1.5 1.5 0 0 0 1.37.91h.15a1.82 1.82 0 1 1 0 3.64h-.08a1.5 1.5 0 0 0-1.37.91z"
			/>
		</svg>
	</button>
</header>

<!--
  Who is going, and what they said they would pick up (§8.6).

  It sits directly under the header rather than in the dock because it is
  status first and a control second: the common case is reading it, not
  pressing it. The action still clears 44px.

  A private store is visible to its owner alone (§8.4), so "I'm going to
  this shop" would only ever be announcing a trip to yourself. The strip is
  simply not useful there, so it does not render.
-->
{#if store?.visibility !== 'private'}
<div class="claim" class:mine={store?.claimedByMe}>
	<div class="claim-text">
		<p class="claim-who">{claimLine}</p>
		{#if store?.claimNote}
			<p class="claim-note">“{store.claimNote}”</p>
		{/if}
	</div>
	{#if store?.claimedByMe}
		<button class="claim-btn" type="button" disabled={claimBusy} onclick={openClaim}>
			{m.claimEdit}
		</button>
	{:else}
		<button class="claim-btn" type="button" disabled={claimBusy} onclick={openClaim}>
			{store?.claimedByName ? m.claimTakeOver : m.claimGo}
		</button>
	{/if}
</div>
{/if}

<div class="body">
	<Banner message={list.error} onretry={() => list.load()} />

	{#if items.length === 0}
		<div class="empty">
			<p class="z-card-title">{m.listEmptyTitle}</p>
			<p class="z-meta">{m.listEmptyBody}</p>
		</div>
	{:else}
		<ul>
			{#each pending as item (item.id)}
				<li>
					<ItemRow
						{item}
						busy={list.busy.has(item.id)}
						ontoggle={(i) => list.tick(i)}
						onopen={openItem}
					/>
				</li>
			{/each}
		</ul>

		{#if ticked.length > 0}
			<p class="divider"><span>{m.listDivider(ticked.length)}</span></p>
			<ul>
				{#each ticked as item (item.id)}
					<li>
						<ItemRow
							{item}
							busy={list.busy.has(item.id)}
							ontoggle={(i) => list.untick(i)}
							onopen={openItem}
						/>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<div class="dock">
	{#if boughtCount > 0}
		<button class="z-btn z-btn--secondary" type="button" onclick={() => (finishing = true)}>
			{m.listFinish(boughtCount)}
		</button>
	{/if}
	<button class="z-btn" type="button" onclick={openAdd}>{m.listAddItem}</button>
</div>

<!-- Quick add. Stays open after each item. -->
<Sheet
	open={adding}
	title={store?.name ? m.addSheetTitle(store.name) : m.addSheetTitleAny}
	onclose={() => (adding = false)}
>
	<Banner message={addError} />
	{#if justAdded}
		<p class="added" role="status">{m.addAdded(justAdded)}</p>
	{/if}
	<form onsubmit={submitAdd}>
		<label class="sr-only" for="item-name">{m.addItemPlaceholder}</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="z-field"
			id="item-name"
			bind:this={nameInput}
			placeholder={m.addItemPlaceholder}
			maxlength="200"
			autocomplete="off"
			autofocus
			bind:value={draftName}
		/>
		<label class="sr-only" for="item-note">{m.addNotePlaceholder}</label>
		<input
			class="z-field"
			id="item-note"
			placeholder={m.addNotePlaceholder}
			maxlength="500"
			autocomplete="off"
			bind:value={draftNote}
		/>
		<button class="z-btn" type="submit" disabled={addBusy || draftName.trim().length === 0}>
			{addBusy ? m.addBusy : store?.name ? m.addSubmit(store.name) : m.addSubmitAny}
		</button>
	</form>
</Sheet>

<!-- Item detail -->
<Sheet open={editing !== null} title={m.itemSheetTitle} onclose={() => (editing = null)}>
	<Banner message={editError} />
	<!-- design/Zembil.dc.html "Item detail / edit" artboard: who added it, right
	     under the title. `createdByName` is null only if that account was since
	     deleted (ON DELETE SET NULL), so the line is omitted rather than blank. -->
	{#if editing?.createdByName}
		<p class="z-meta">{m.itemAddedBy(editing.createdByName, relative(editing.createdAt))}</p>
	{/if}
	<form onsubmit={saveItem}>
		<label class="sr-only" for="edit-name">{m.addItemPlaceholder}</label>
		<input class="z-field" id="edit-name" maxlength="200" bind:value={editName} />
		<label class="sr-only" for="edit-note">{m.addNotePlaceholder}</label>
		<input
			class="z-field"
			id="edit-note"
			placeholder={m.addNotePlaceholder}
			maxlength="500"
			bind:value={editNote}
		/>
		<p class="z-meta">{m.itemInStore(store?.name ?? '')}</p>
		<button class="z-btn" type="submit" disabled={editBusy || editName.trim().length === 0}>
			{editBusy ? m.saving : m.save}
		</button>
		<button class="z-btn z-btn--tertiary z-btn--danger" type="button" disabled={editBusy} onclick={deleteItem}>
			{m.delete}
		</button>
	</form>
</Sheet>

<!-- Claim (§8.6). One optional short note, plain text, 140 characters. -->
<Sheet
	open={claiming}
	title={claimConflict ? m.claimSheetTakeOver : store?.claimedByMe ? m.claimSheetEdit : m.claimSheetGo}
	onclose={() => (claiming = false)}
>
	<Banner message={claimError} />
	<form onsubmit={(e) => { e.preventDefault(); void submitClaim(claimConflict); }}>
		<label class="sr-only" for="claim-note">{m.claimNoteLabel}</label>
		<input
			class="z-field"
			id="claim-note"
			placeholder={m.claimNotePlaceholder}
			maxlength={CLAIM_NOTE_MAX}
			autocomplete="off"
			bind:value={claimNote}
		/>
		<p class="z-meta faint">{m.claimNoteLeft(claimNoteLeft)}</p>
		{#if claimConflict}
			<p class="z-meta faint">{m.claimTakeOverHint}</p>
		{/if}
		<button class="z-btn" type="submit" disabled={claimBusy}>
			{claimConflict ? m.claimSubmitTakeOver : m.claimSubmit}
		</button>
		{#if store?.claimedByMe}
			<button
				class="z-btn z-btn--tertiary z-btn--danger"
				type="button"
				disabled={claimBusy}
				onclick={releaseClaim}
			>
				{m.claimRelease}
			</button>
		{/if}
	</form>
</Sheet>

<!--
  Shop settings (§8.4, R-14, D-043). `PATCH /api/stores/{id}` has implemented
  rename, recolour, reorder and archive since M1 with no screen calling any of
  it; visibility is the fifth field on the same endpoint and this is its home.
-->
<Sheet open={settingsOpen} title={m.storeSettings} onclose={() => (settingsOpen = false)}>
	<Banner message={settingsError} />
	<form onsubmit={saveSettings}>
		<label class="sr-only" for="store-name">{m.storeNameLabel}</label>
		<input
			class="z-field"
			id="store-name"
			placeholder={m.storeNameLabel}
			maxlength="60"
			bind:value={settingsName}
		/>

		<fieldset class="colours">
			<legend class="z-meta">{m.storeColour}</legend>
			{#each STORE_COLORS as key (key)}
				<label class="swatch" data-color={key}>
					<input
						type="radio"
						name="store-colour"
						value={key}
						checked={settingsColor === key}
						onchange={() => (settingsColor = key)}
					/>
					<span class="sr-only">{key}</span>
				</label>
			{/each}
		</fieldset>

		<button class="z-btn" type="submit" disabled={settingsBusy || settingsName.trim().length === 0}>
			{settingsBusy ? m.saving : m.save}
		</button>
	</form>

	<!--
	  §8.4a. The buttons are here only for the member who created the shop and
	  for an admin; everybody else sees the current setting as a sentence and no
	  control. The server refuses the PATCH either way (`403 FORBIDDEN`) — this
	  is what keeps the interface from offering a tap that cannot work.
	-->
	<section class="visibility">
		<h3 class="z-card-title">{m.storeVisibility}</h3>
		{#if store?.canChangeVisibility}
			<div class="segmented" role="group" aria-label={m.storeVisibility}>
				<button
					type="button"
					class:on={store?.visibility === 'public'}
					aria-pressed={store?.visibility === 'public'}
					disabled={settingsBusy}
					onclick={() => setVisibility('public')}
				>
					{m.storeVisibilityPublic}
				</button>
				<button
					type="button"
					class:on={store?.visibility === 'private'}
					aria-pressed={store?.visibility === 'private'}
					disabled={settingsBusy}
					onclick={() => setVisibility('private')}
				>
					{m.storeVisibilityPrivate}
				</button>
			</div>
		{/if}
		<p class="z-meta faint">
			{store?.canChangeVisibility
				? store?.visibility === 'private'
					? m.storeVisibilityPrivateHelp
					: m.storeVisibilityPublicHelp
				: m.storeVisibilityLocked}
		</p>
	</section>

	<section class="visibility">
		<button
			class="z-btn z-btn--tertiary z-btn--danger"
			type="button"
			disabled={settingsBusy}
			onclick={archiveStore}
		>
			{m.storeArchive}
		</button>
		<p class="z-meta faint">{m.storeArchiveHelp}</p>
	</section>

	<!--
	  §9.1 / R-23 — the permanent one. It sits below Archive on purpose: the
	  reversible action is the one you meet first, and the copy on each says
	  which is which before the tap rather than after it.
	-->
	<section class="visibility danger">
		{#if confirmingDelete}
			<p class="z-card-title">{m.storeDeleteConfirm(store?.name ?? '')}</p>
			<p class="z-meta faint">{m.storeDeleteHelp}</p>
			<div class="confirm-row">
				<button
					class="z-btn z-btn--tertiary z-btn--auto"
					type="button"
					disabled={settingsBusy}
					onclick={() => (confirmingDelete = false)}
				>
					{m.storeDeleteKeep}
				</button>
				<button
					class="z-btn z-btn--danger go"
					type="button"
					disabled={settingsBusy}
					onclick={deleteStore}
				>
					{settingsBusy ? m.storeDeleting : m.storeDeleteSubmit}
				</button>
			</div>
		{:else}
			<button
				class="z-btn z-btn--tertiary z-btn--danger"
				type="button"
				disabled={settingsBusy}
				onclick={() => (confirmingDelete = true)}
			>
				{m.storeDelete}
			</button>
			<p class="z-meta faint">{m.storeDeleteHelp}</p>
		{/if}
	</section>
</Sheet>

<!-- Finish trip -->
<Sheet open={finishing} title={m.finishTitle} onclose={() => (finishing = false)}>
	<Banner message={finishError} />
	<p class="z-meta">
		{m.finishBought(boughtCount)}
		{leftCount > 0 ? m.finishLeft(leftCount) : m.finishNothingLeft}
	</p>
	<button class="z-btn" type="button" disabled={finishBusy} onclick={finishTrip}>
		{finishBusy ? m.finishBusy : m.finishConfirm}
	</button>
	<button class="z-btn z-btn--secondary" type="button" onclick={() => (finishing = false)}>
		{m.finishKeep}
	</button>
</Sheet>

<style>
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 20px 24px 12px;
	}

	.titles {
		flex: 1;
		min-width: 0;
	}

	.gear {
		flex: none;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-right: -10px;
		border-radius: 14px;
		color: var(--text-2);
	}

	.private {
		font-size: 12px;
		vertical-align: middle;
		margin-left: 8px;
	}

	/* The claim strip. Status first, control second. */
	.claim {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 0 20px 12px;
		padding: 10px 12px 10px 14px;
		border-radius: 18px;
		background: var(--surface-muted);
	}

	.claim.mine {
		background: var(--surface-sunk, var(--surface-muted));
	}

	.claim-text {
		flex: 1;
		min-width: 0;
	}

	.claim-who {
		font-size: 15px;
		font-weight: 600;
		color: var(--text);
	}

	.claim-note {
		font-size: 15px;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}

	.claim-btn {
		flex: none;
		min-height: 44px;
		min-width: 44px;
		padding: 0 14px;
		border-radius: 14px;
		font-size: 15px;
		font-weight: 700;
		color: var(--accent);
	}

	.faint {
		color: var(--text-faint);
	}

	.colours {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		border: 0;
		padding: 0;
		margin: 0;
	}

	.colours legend {
		margin-bottom: 6px;
	}

	/* 44px, per PROJECT.md §8 — a colour swatch is still a tap target. */
	.swatch {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 14px;
		background: var(--spine, var(--surface-muted));
		cursor: pointer;
	}

	.swatch input {
		appearance: none;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 2px solid transparent;
	}

	.swatch input:checked {
		border-color: var(--surface);
		box-shadow: 0 0 0 2px var(--text);
	}

	.visibility {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 18px;
		padding-top: 18px;
		border-top: 1px solid var(--rule);
	}

	/* The armed confirm step. Two 44px targets side by side, "Keep it" first so
	   the destructive one is not where the thumb already was. */
	.confirm-row {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 10px;
		align-items: center;
	}

	.confirm-row .go {
		border-color: var(--danger);
		font-weight: 700;
	}

	.segmented {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 6px;
		padding: 6px;
		border-radius: 16px;
		background: var(--surface-muted);
	}

	.segmented button {
		height: 44px;
		border-radius: 12px;
		font-size: 15px;
		font-weight: 600;
		color: var(--text-2);
	}

	.segmented button.on {
		background: var(--surface);
		color: var(--text);
		font-weight: 700;
	}

	.back {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-left: -10px;
		border-radius: 14px;
		color: var(--spine, var(--accent));
	}

	.body {
		padding: 0 20px 160px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.divider {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 12px 2px 2px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--rule);
	}

	.empty {
		margin-top: 8px;
		padding: 32px 24px;
		border: 1px dashed var(--border-dashed);
		border-radius: 22px;
		text-align: center;
		color: var(--text-faint);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.dock {
		position: fixed;
		inset: auto 0 calc(82px + env(safe-area-inset-bottom));
		z-index: 10;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		background: linear-gradient(180deg, transparent, var(--bg) 40%);
		pointer-events: none;
	}

	.dock :global(.z-btn) {
		pointer-events: auto;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.added {
		font-size: 15px;
		font-weight: 600;
		color: var(--accent-deep);
	}
</style>
