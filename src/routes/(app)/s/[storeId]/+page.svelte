<!--
  One store's open list — docs/DESIGN.md §4, CONTRACT.md §3.5.

  Adding an item is the most frequent action in the app, so it costs one tap
  from this screen and the sheet STAYS OPEN afterwards: the second item should
  cost one tap, not four.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import type { Item } from '$lib/types';
	import { untrack } from 'svelte';
	import { listFor, messageOf, shops, sortItems } from '$lib/client/app.svelte';
	import { newClientId } from '$lib/client/api';
	import Banner from '$lib/components/Banner.svelte';
	import ItemRow from '$lib/components/ItemRow.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { data } = $props();

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

	let boughtCount = $derived(ticked.length);
	let leftCount = $derived(pending.length);
</script>

<svelte:head><title>{store?.name ?? 'List'} · Zembil</title></svelte:head>

<header data-color={store?.color}>
	<a class="back" href="/" aria-label="Back to shops">
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
	<div>
		<p class="z-eyebrow">Shopping at</p>
		<h1 class="z-title">{store?.name ?? ''}</h1>
	</div>
</header>

<div class="body">
	<Banner message={list.error} onretry={() => list.load()} />

	{#if items.length === 0}
		<div class="empty">
			<p class="z-card-title">The basket is empty</p>
			<p class="z-meta">Add the first thing you need here.</p>
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
			<p class="divider"><span>In the basket · {ticked.length}</span></p>
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
			Finish trip · {boughtCount} bought
		</button>
	{/if}
	<button class="z-btn" type="button" onclick={openAdd}>Add an item</button>
</div>

<!-- Quick add. Stays open after each item. -->
<Sheet open={adding} title="Add to {store?.name ?? 'this shop'}" onclose={() => (adding = false)}>
	<Banner message={addError} />
	{#if justAdded}
		<p class="added" role="status">Added “{justAdded}”. Next?</p>
	{/if}
	<form onsubmit={submitAdd}>
		<label class="sr-only" for="item-name">Item</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="z-field"
			id="item-name"
			bind:this={nameInput}
			placeholder="Item"
			maxlength="200"
			autocomplete="off"
			autofocus
			bind:value={draftName}
		/>
		<label class="sr-only" for="item-note">Quantity or note</label>
		<input
			class="z-field"
			id="item-note"
			placeholder="Quantity or note"
			maxlength="500"
			autocomplete="off"
			bind:value={draftNote}
		/>
		<button class="z-btn" type="submit" disabled={addBusy || draftName.trim().length === 0}>
			{addBusy ? 'Adding…' : `Add to ${store?.name ?? 'list'}`}
		</button>
	</form>
</Sheet>

<!-- Item detail -->
<Sheet open={editing !== null} title="Item" onclose={() => (editing = null)}>
	<Banner message={editError} />
	<form onsubmit={saveItem}>
		<label class="sr-only" for="edit-name">Item</label>
		<input class="z-field" id="edit-name" maxlength="200" bind:value={editName} />
		<label class="sr-only" for="edit-note">Quantity or note</label>
		<input
			class="z-field"
			id="edit-note"
			placeholder="Quantity or note"
			maxlength="500"
			bind:value={editNote}
		/>
		<p class="z-meta">In {store?.name ?? ''}</p>
		<button class="z-btn" type="submit" disabled={editBusy || editName.trim().length === 0}>
			{editBusy ? 'Saving…' : 'Save'}
		</button>
		<button class="z-btn z-btn--tertiary z-btn--danger" type="button" disabled={editBusy} onclick={deleteItem}>
			Delete
		</button>
	</form>
</Sheet>

<!-- Finish trip -->
<Sheet open={finishing} title="Finish this trip?" onclose={() => (finishing = false)}>
	<Banner message={finishError} />
	<p class="z-meta">
		{boughtCount}
		{boughtCount === 1 ? 'thing' : 'things'} bought.
		{#if leftCount > 0}
			{leftCount}
			{leftCount === 1 ? 'thing' : 'things'} still on the list will move to the next trip here.
		{:else}
			Nothing is left behind.
		{/if}
	</p>
	<button class="z-btn" type="button" disabled={finishBusy} onclick={finishTrip}>
		{finishBusy ? 'Finishing…' : 'Finish trip'}
	</button>
	<button class="z-btn z-btn--secondary" type="button" onclick={() => (finishing = false)}>
		Keep shopping
	</button>
</Sheet>

<style>
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 20px 24px 12px;
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
