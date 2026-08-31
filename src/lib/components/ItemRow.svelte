<!--
  One row of a list — docs/DESIGN.md §3. 68px tall, which is not a rounding of
  60: a thumb moving down a list must not be able to tick the row above or below
  the one it aimed at.

  The whole row is the checkbox. A 26px box inside a 68px row would be a 26px
  target surrounded by dead space, and the row already has exactly one meaning.
-->
<script lang="ts">
	import type { Item } from '$lib/types';

	interface Props {
		item: Item;
		busy: boolean;
		ontoggle: (item: Item) => void;
		onopen: (item: Item) => void;
	}

	let { item, busy, ontoggle, onopen }: Props = $props();
	let ticked = $derived(item.state === 'ticked');
</script>

<div class="row" class:ticked>
	<button
		class="main"
		type="button"
		role="checkbox"
		aria-checked={ticked}
		disabled={busy}
		onclick={() => ontoggle(item)}
	>
		<span class="box" class:on={ticked} class:z-tick-anim={ticked}>
			{#if ticked}
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
					<path
						d="M4 12.5 9.5 18 20 6.5"
						fill="none"
						stroke="currentColor"
						stroke-width="3"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			{/if}
		</span>
		<span class="text">
			<span class="name">{item.name}</span>
			{#if item.note}<span class="note">{item.note}</span>{/if}
			{#if item.carryCount > 0 && !ticked}
				<span class="note carried"
					>Carried over {item.carryCount}
					{item.carryCount === 1 ? 'time' : 'times'}</span
				>
			{/if}
		</span>
	</button>

	{#if ticked}
		<button class="undo" type="button" disabled={busy} onclick={() => ontoggle(item)}>Undo</button>
	{:else}
		<button class="edit" type="button" aria-label="Edit {item.name}" onclick={() => onopen(item)}>
			<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
				<path
					d="M4 20h4L19 9l-4-4L4 16z"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
	{/if}
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		min-height: 68px;
		padding: 0 8px 0 18px;
		border-radius: 20px;
		background: var(--surface);
		border: 1px solid var(--border);
	}

	.row.ticked {
		background: var(--surface-sunk);
	}

	.main {
		display: flex;
		align-items: center;
		gap: 14px;
		flex: 1;
		min-width: 0;
		min-height: 68px;
		padding: 0;
		text-align: left;
	}

	.box {
		flex: none;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 8px;
		border: 2.5px solid var(--border-strong);
		color: var(--on-accent);
	}

	.box.on {
		background: var(--accent);
		border-color: var(--accent);
	}

	.text {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.name {
		/* 19px is the floor for list rows. */
		font-size: 19px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ticked .name {
		color: var(--text-3);
		text-decoration: line-through;
		text-decoration-color: var(--text-disabled);
	}

	.note {
		font-size: 14px;
		color: var(--text-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.carried {
		color: var(--accent-deep);
	}

	.undo {
		flex: none;
		height: 44px;
		padding: 0 16px;
		border-radius: 14px;
		color: var(--accent-deep);
		font-size: 15px;
		font-weight: 700;
	}

	.edit {
		flex: none;
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		border-radius: 14px;
		color: var(--text-muted);
	}

	button[disabled] {
		opacity: 0.55;
	}
</style>
