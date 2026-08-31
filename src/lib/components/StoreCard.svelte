<!-- A store on the home screen — docs/DESIGN.md §3, §4. -->
<script lang="ts">
	import type { StoreSummary } from '$lib/types';

	interface Props {
		store: StoreSummary;
	}

	let { store }: Props = $props();
</script>

<a class="card z-card" href="/s/{store.id}" data-color={store.color}>
	<span class="spine" aria-hidden="true"></span>
	<span class="body">
		<span class="name">{store.name}</span>
		<span class="sub z-meta">
			{#if store.pendingCount === 0}
				Nothing needed
			{:else}
				{store.pendingCount} to buy
			{/if}
			{#if store.tickedCount > 0}
				· {store.tickedCount} in the basket
			{/if}
		</span>
	</span>
	{#if store.pendingCount > 0}
		<span class="count">{store.pendingCount}</span>
	{/if}
</a>

<style>
	.card {
		display: flex;
		align-items: center;
		gap: 16px;
		text-decoration: none;
		color: inherit;
	}

	.spine {
		flex: none;
		width: 8px;
		height: 56px;
		border-radius: 4px;
		background: var(--spine, var(--accent));
	}

	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.name {
		font-size: 21px;
		font-weight: 700;
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.count {
		flex: none;
		display: grid;
		place-items: center;
		min-width: 44px;
		height: 44px;
		padding: 0 12px;
		border-radius: 14px;
		background: var(--chip-bg, var(--accent-tint));
		color: var(--chip-fg, var(--accent-deep));
		font-size: 17px;
		font-weight: 700;
	}
</style>
