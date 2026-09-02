<!-- A store on the home screen — docs/DESIGN.md §3, §4. -->
<script lang="ts">
	import type { StoreSummary } from '$lib/types';
	import { messages } from '$lib/client/i18n';

	interface Props {
		store: StoreSummary;
	}

	let { store }: Props = $props();

	const m = $derived(messages());
</script>

<a class="card z-card" href="/s/{store.id}" data-color={store.color}>
	<span class="spine" aria-hidden="true"></span>
	<span class="body">
		<span class="name">
			{store.name}
			<!-- §8.4: a private shop is marked wherever it appears, so nobody adds
			     to it expecting the family to see it. -->
			{#if store.visibility === 'private'}
				<span class="badge">{m.cardPrivate}</span>
			{/if}
		</span>
		<span class="sub z-meta">
			{store.pendingCount === 0 ? m.cardNothingNeeded : m.cardToBuy(store.pendingCount)}
			{#if store.tickedCount > 0}
				· {m.cardInBasket(store.tickedCount)}
			{/if}
		</span>
		<!-- §8.6: who is going. The home screen is where this is most useful —
		     it is what stops two people driving to the same shop. -->
		{#if store.claimedByName}
			<span class="claim z-meta">
				{store.claimedByMe ? m.claimByMe : m.cardClaimed(store.claimedByName)}
				{#if store.claimNote}<span class="note">· “{store.claimNote}”</span>{/if}
			</span>
		{/if}
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

	.badge {
		display: inline-block;
		vertical-align: middle;
		margin-left: 8px;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--surface-muted);
		color: var(--text-2);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.01em;
	}

	.claim {
		color: var(--accent-deep, var(--text-2));
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.claim .note {
		font-weight: 400;
		color: var(--text-2);
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
