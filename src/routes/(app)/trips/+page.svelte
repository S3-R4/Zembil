<!-- Trip history — docs/DESIGN.md §4, CONTRACT.md §3.6. -->
<script lang="ts">
	import { api } from '$lib/client/api';
	import { messageOf } from '$lib/client/app.svelte';
	import type { Item, TripSummary } from '$lib/types';
	import Banner from '$lib/components/Banner.svelte';

	let { data } = $props();

	// Null until chosen; the effective store falls back to the first one the load
	// returned, so a fresh visit shows something without a second render pass.
	let chosen = $state<string | null>(null);
	let storeId = $derived(chosen ?? data.stores[0]?.id ?? '');
	let trips = $state<TripSummary[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let expanded = $state<string | null>(null);
	let itemsByTrip = $state<Record<string, Item[]>>({});

	$effect(() => {
		const id = storeId;
		if (!id) return;
		loading = true;
		error = null;
		api<{ trips: TripSummary[] }>(`/api/stores/${id}/trips?limit=20`)
			.then((body) => {
				trips = body.trips;
			})
			.catch((err) => {
				error = messageOf(err);
			})
			.finally(() => {
				loading = false;
			});
	});

	async function toggle(trip: TripSummary) {
		if (expanded === trip.id) {
			expanded = null;
			return;
		}
		expanded = trip.id;
		if (itemsByTrip[trip.id]) return;
		try {
			const body = await api<{ items: Item[] }>(`/api/trips/${trip.id}`);
			itemsByTrip = { ...itemsByTrip, [trip.id]: body.items };
		} catch (err) {
			error = messageOf(err);
		}
	}

	const when = (ms: number | null) =>
		ms === null
			? ''
			: new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<svelte:head><title>Trips · Zembil</title></svelte:head>

<header>
	<p class="z-eyebrow">What we bought</p>
	<h1 class="z-title">Trips</h1>
</header>

<div class="body">
	{#if data.stores.length > 1}
		<div class="tabs" role="tablist" aria-label="Shop">
			{#each data.stores as store (store.id)}
				<button
					type="button"
					role="tab"
					class="tab"
					aria-selected={storeId === store.id}
					class:on={storeId === store.id}
					onclick={() => (chosen = store.id)}
				>
					{store.name}
				</button>
			{/each}
		</div>
	{/if}

	<Banner message={error} />

	{#if data.stores.length === 0}
		<p class="empty z-meta">No shops yet.</p>
	{:else if loading && trips.length === 0}
		<div class="z-skeleton skeleton"></div>
	{:else if trips.length === 0}
		<p class="empty z-meta">No finished trips here yet.</p>
	{:else}
		<ul>
			{#each trips as trip (trip.id)}
				<li class="z-card">
					<div class="head">
						<div>
							<p class="z-card-title">Trip {trip.seq}</p>
							<p class="z-meta">
								{when(trip.closedAt)}
								{#if trip.closedByName}· finished by {trip.closedByName}{/if}
							</p>
						</div>
						<span class="z-chip">{trip.boughtCount}</span>
					</div>
					<p class="z-meta">
						{trip.boughtCount} bought
						{#if trip.carriedCount > 0}· {trip.carriedCount} left on the list{/if}
					</p>
					<button class="z-btn z-btn--tertiary" type="button" onclick={() => toggle(trip)}>
						{expanded === trip.id ? 'Hide items' : `See ${trip.boughtCount + trip.carriedCount} items`}
					</button>
					{#if expanded === trip.id}
						{#if itemsByTrip[trip.id]}
							<ul class="items">
								{#each itemsByTrip[trip.id] as item (item.id)}
									<li class:left={item.state !== 'ticked'}>
										<span>{item.name}</span>
										{#if item.state !== 'ticked'}<span class="tag">left</span>{/if}
									</li>
								{/each}
							</ul>
						{:else}
							<div class="z-skeleton skeleton"></div>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	header {
		padding: 28px 24px 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.body {
		padding: 0 20px 32px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.tabs {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		padding-bottom: 4px;
	}

	.tab {
		flex: none;
		height: 44px;
		padding: 0 16px;
		border-radius: 14px;
		background: var(--surface-muted);
		color: var(--text-2);
		font-size: 15px;
		font-weight: 600;
	}

	.tab.on {
		background: var(--accent-tint);
		color: var(--accent-deep);
		font-weight: 700;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	li.z-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.items {
		gap: 0;
		border-top: 1px solid var(--rule);
		padding-top: 8px;
	}

	.items li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 36px;
		font-size: 16px;
	}

	.items li.left {
		color: var(--text-3);
	}

	.tag {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.empty {
		padding: 32px 0;
		text-align: center;
	}

	.skeleton {
		height: 72px;
		border-radius: 20px;
	}
</style>
