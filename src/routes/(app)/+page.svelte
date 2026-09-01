<!--
  Shops — docs/DESIGN.md §4 and the Stores artboards in design/Zembil.dc.html.

  The primary action here is **Add an item**, not "Add a shop". That is what the
  canvas puts in the 68px slot, and it is the right way round: adding an item is
  the most frequent action in the app and creating a shop happens a handful of
  times ever. Making the rare action primary cost a tap on the common one.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { listFor, messageOf, shops } from '$lib/client/app.svelte';
	import { newClientId } from '$lib/client/api';
	import { STORE_COLORS } from '$lib/client/palette';
	import Banner from '$lib/components/Banner.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import StoreCard from '$lib/components/StoreCard.svelte';

	let { data } = $props();

	// Rendered from the load payload until the reactive store has been seeded.
	// The seeding happens in an effect, and effects do not run during SSR — so
	// reading `shops.stores` directly would server-render "No shops yet" and hold
	// it until the bundle hydrates. It must stay in an effect: `shops` is a
	// module singleton that the Node process shares across every request, and a
	// write outside an effect would serve one member's state to the next caller.
	let stores = $derived(shops.loaded ? shops.stores : data.stores);

	// `untrack` for the same reason as the list screen: the write must not become
	// a dependency of the effect that performs it.
	$effect(() => {
		const seeded = data.stores;
		untrack(() => shops.seed(seeded));
	});

	// ---- add an item ------------------------------------------------------
	let adding = $state(false);
	let chosenStore = $state<string | null>(null);
	let targetStore = $derived(
		stores.find((s) => s.id === chosenStore) ?? stores[0] ?? null
	);
	let draftName = $state('');
	let draftNote = $state('');
	let addBusy = $state(false);
	let addError = $state<string | null>(null);
	let justAdded = $state<string | null>(null);
	let nameInput = $state<HTMLInputElement | null>(null);
	// §3.5 / R-17: one clientId per compose, reused across every retry of THAT
	// compose. `failedFor` keys it to the text, so giving up and typing something
	// else is a new item rather than a retry of the old one.
	let clientId = $state(newClientId());
	let failedFor = $state<string | null>(null);

	function openAdd() {
		addError = null;
		justAdded = null;
		adding = true;
	}

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		const store = targetStore;
		const name = draftName.trim();
		if (addBusy || !store || name.length === 0) return;

		if (failedFor !== null && failedFor !== name) {
			clientId = newClientId();
			failedFor = null;
		}
		addBusy = true;
		addError = null;
		try {
			const added = await listFor(store.id).add(name, draftNote.trim() || null, clientId);
			justAdded = added.name;
			draftName = '';
			draftNote = '';
			clientId = newClientId();
			failedFor = null;
			// The sheet stays open: the second item should cost one tap, not four.
			nameInput?.focus();
			await shops.load();
		} catch (err) {
			failedFor = name;
			addError = messageOf(err);
		} finally {
			addBusy = false;
		}
	}

	// ---- add a shop -------------------------------------------------------
	let addingShop = $state(false);
	let shopName = $state('');
	let shopColor = $state<string | null>(null);
	let shopBusy = $state(false);
	let shopError = $state<string | null>(null);

	async function createStore(event: SubmitEvent) {
		event.preventDefault();
		if (shopBusy || shopName.trim().length === 0) return;
		shopBusy = true;
		shopError = null;
		try {
			const store = await shops.create(shopName.trim(), shopColor ?? undefined);
			addingShop = false;
			shopName = '';
			shopColor = null;
			await goto(`/s/${store.id}`);
		} catch (err) {
			shopError = messageOf(err);
		} finally {
			shopBusy = false;
		}
	}

	let initial = $derived((data.user?.displayName ?? '?').trim().charAt(0).toUpperCase());
</script>

<svelte:head><title>Shops · Zembil</title></svelte:head>

<header>
	<div>
		<p class="z-eyebrow">Our lists</p>
		<h1 class="z-title">Shops</h1>
	</div>
	<a class="avatar" href="/you" aria-label="Your account">{initial}</a>
</header>

<div class="body">
	<Banner message={shops.error} onretry={() => shops.load()} />

	{#if stores.length === 0}
		<div class="empty">
			<p class="z-card-title">No shops yet</p>
			<p class="z-meta">Add one, and everything you need there lives on its own list.</p>
		</div>
	{:else}
		<ul>
			{#each stores as store (store.id)}
				<li><StoreCard {store} /></li>
			{/each}
		</ul>
	{/if}

	<button class="add-shop" type="button" onclick={() => (addingShop = true)}>+ Add a shop</button>
</div>

<div class="dock">
	<button class="z-btn" type="button" disabled={stores.length === 0} onclick={openAdd}>
		Add an item
	</button>
</div>

<!-- Quick add, from anywhere. Stays open after each item. -->
<Sheet
	open={adding}
	title="Add to {targetStore?.name ?? 'a shop'}"
	onclose={() => (adding = false)}
>
	<Banner message={addError} />
	{#if justAdded}
		<p class="added" role="status">Added “{justAdded}”. Next?</p>
	{/if}
	<form onsubmit={submitAdd}>
		<label class="sr-only" for="quick-name">Item</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="z-field"
			id="quick-name"
			bind:this={nameInput}
			placeholder="Item"
			maxlength="200"
			autocomplete="off"
			autofocus
			bind:value={draftName}
		/>
		<label class="sr-only" for="quick-note">Quantity or note</label>
		<input
			class="z-field"
			id="quick-note"
			placeholder="Quantity or note"
			maxlength="500"
			autocomplete="off"
			bind:value={draftNote}
		/>

		{#if stores.length > 1}
			<fieldset>
				<legend class="z-eyebrow">Shop</legend>
				<div class="shops">
					{#each stores as store (store.id)}
						<button
							type="button"
							class="shop"
							data-color={store.color}
							class:on={targetStore?.id === store.id}
							aria-pressed={targetStore?.id === store.id}
							onclick={() => (chosenStore = store.id)}
						>
							{store.name}
						</button>
					{/each}
				</div>
			</fieldset>
		{/if}

		<button class="z-btn" type="submit" disabled={addBusy || draftName.trim().length === 0}>
			{addBusy ? 'Adding…' : `Add to ${targetStore?.name ?? 'shop'}`}
		</button>
	</form>
</Sheet>

<Sheet open={addingShop} title="Add a shop" onclose={() => (addingShop = false)}>
	<Banner message={shopError} />
	<form onsubmit={createStore}>
		<label class="sr-only" for="store-name">Shop name</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="z-field"
			id="store-name"
			placeholder="Shop name"
			maxlength="60"
			autofocus
			bind:value={shopName}
		/>

		<fieldset>
			<legend class="z-eyebrow">Colour</legend>
			<div class="swatches">
				{#each STORE_COLORS as key (key)}
					<button
						type="button"
						class="swatch"
						data-color={key}
						class:on={shopColor === key}
						aria-label={key}
						aria-pressed={shopColor === key}
						onclick={() => (shopColor = shopColor === key ? null : key)}
					></button>
				{/each}
			</div>
		</fieldset>

		<button class="z-btn" type="submit" disabled={shopBusy || shopName.trim().length === 0}>
			{shopBusy ? 'Adding…' : 'Add shop'}
		</button>
	</form>
</Sheet>

<style>
	header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		padding: 28px 24px 12px;
	}

	header > div {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.avatar {
		flex: none;
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		border-radius: 16px;
		background: var(--surface-muted);
		border: 1px solid var(--border-strong);
		color: var(--text-2);
		font-size: 19px;
		font-weight: 700;
		text-decoration: none;
	}

	.body {
		padding: 0 20px 140px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
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

	.add-shop {
		min-height: 56px;
		border: 1px dashed var(--border-dashed);
		border-radius: 22px;
		color: var(--text-3);
		font-size: 17px;
		font-weight: 600;
	}

	.dock {
		position: fixed;
		inset: auto 0 calc(82px + env(safe-area-inset-bottom));
		z-index: 10;
		padding: 20px;
		/* The list scrolls under the action rather than stopping short of it. */
		background: linear-gradient(180deg, transparent, var(--bg) 40%);
		pointer-events: none;
	}

	.dock :global(.z-btn) {
		pointer-events: auto;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.swatches,
	.shops {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.swatch {
		width: 44px;
		height: 44px;
		border-radius: 14px;
		background: var(--spine);
		border: 3px solid transparent;
	}

	.swatch.on {
		border-color: var(--text);
	}

	.shop {
		min-height: 44px;
		padding: 0 14px;
		border-radius: 14px;
		background: var(--surface-muted);
		color: var(--text-2);
		font-size: 15px;
		font-weight: 600;
	}

	.shop.on {
		background: var(--chip-bg);
		color: var(--chip-fg);
		font-weight: 700;
	}

	.added {
		font-size: 15px;
		font-weight: 600;
		color: var(--accent-deep);
	}
</style>
