<script lang="ts">
	import '../app.css';
	import { applyAppearance, readAppearance } from '$lib/client/theme';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	// Applied on mount rather than from an inline script in app.html: `kit.csp`
	// runs `script-src 'self'` with hashes for SvelteKit's own payload, and an
	// inline script of ours would need a hash it cannot get. The cost is a brief
	// flash for the minority who override the OS setting — 'auto' sets no
	// attribute at all, so it matches prefers-color-scheme from the first paint.
	$effect(() => {
		applyAppearance(readAppearance());
	});
</script>

{@render children()}
