<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<main>
	<div class="mark" aria-hidden="true">
		<svg viewBox="0 0 48 48" width="40" height="40">
			<path
				d="M8 16h32l-4 24H12z M14 16a10 10 0 0 1 20 0"
				fill="none"
				stroke="currentColor"
				stroke-width="3"
				stroke-linejoin="round"
			/>
		</svg>
	</div>
	{@render children()}
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		/* dvh, never vh: on mobile Safari 100vh is taller than the visible
		 * viewport and the sign-in button lands under the toolbar. */
		min-height: 100dvh;
		padding: 32px 24px calc(32px + env(safe-area-inset-bottom));
		gap: 20px;
	}

	.mark {
		color: var(--accent);
	}
</style>
