<!-- Shops — docs/DESIGN.md §4. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { shops, messageOf } from '$lib/client/app.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import StoreCard from '$lib/components/StoreCard.svelte';
	import { STORE_COLORS } from '$lib/client/palette';

	let { data } = $props();

	// Seeded from the load so the first paint is real content, then owned by the
	// reactive store so realtime hints and writes both land in one place.
	$effect(() => {
		if (!shops.loaded) shops.seed(data.stores);
	});

	let adding = $state(false);
	let name = $state('');
	let color = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function createStore(event: SubmitEvent) {
		event.preventDefault();
		if (busy || name.trim().length === 0) return;
		busy = true;
		error = null;
		try {
			const store = await shops.create(name.trim(), color ?? undefined);
			adding = false;
			name = '';
			color = null;
			await goto(`/s/${store.id}`);
		} catch (err) {
			error = messageOf(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Shops · Zembil</title></svelte:head>

<header>
	<p class="z-eyebrow">Our lists</p>
	<h1 class="z-title">Shops</h1>
</header>

<div class="body">
	<Banner message={shops.error} onretry={() => shops.load()} />

	{#if shops.stores.length === 0}
		<div class="empty">
			<p class="z-card-title">No shops yet</p>
			<p class="z-meta">Add one, and everything you need there lives on its own list.</p>
		</div>
	{:else}
		<ul>
			{#each shops.stores as store (store.id)}
				<li><StoreCard {store} /></li>
			{/each}
		</ul>
	{/if}
</div>

<div class="dock">
	<button class="z-btn" type="button" onclick={() => (adding = true)}>Add a shop</button>
</div>

<Sheet open={adding} title="Add a shop" onclose={() => (adding = false)}>
	<Banner message={error} />
	<form onsubmit={createStore}>
		<label class="sr-only" for="store-name">Shop name</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="z-field"
			id="store-name"
			placeholder="Shop name"
			maxlength="60"
			autofocus
			bind:value={name}
		/>

		<fieldset>
			<legend class="z-eyebrow">Colour</legend>
			<div class="swatches">
				{#each STORE_COLORS as key (key)}
					<button
						type="button"
						class="swatch"
						data-color={key}
						class:on={color === key}
						aria-label={key}
						aria-pressed={color === key}
						onclick={() => (color = color === key ? null : key)}
					></button>
				{/each}
			</div>
		</fieldset>

		<button class="z-btn" type="submit" disabled={busy || name.trim().length === 0}>
			{busy ? 'Adding…' : 'Add shop'}
		</button>
	</form>
</Sheet>

<style>
	header {
		padding: 28px 24px 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
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

	.swatches {
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
</style>
