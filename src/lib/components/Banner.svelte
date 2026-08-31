<!-- An inline error with an optional retry. Shows what the server said (§3.1),
     never a substitute of our own. -->
<script lang="ts">
	interface Props {
		message: string | null;
		onretry?: () => void;
	}

	let { message, onretry }: Props = $props();
</script>

{#if message}
	<div class="banner" role="alert">
		<span>{message}</span>
		{#if onretry}
			<button type="button" onclick={onretry}>Retry</button>
		{/if}
	</div>
{/if}

<style>
	.banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 56px;
		padding: 10px 16px;
		border-radius: 16px;
		background: var(--accent-tint);
		color: var(--accent-deep);
		font-size: 15px;
		font-weight: 600;
	}

	button {
		flex: none;
		/* 44px, not 36: DESIGN.md §3 has no exceptions, and this is the one
		 * control §4 names for the offline state. */
		min-width: 44px;
		height: 44px;
		padding: 0 14px;
		border-radius: 12px;
		background: var(--surface);
		color: var(--accent-deep);
		font-size: 15px;
		font-weight: 700;
	}
</style>
