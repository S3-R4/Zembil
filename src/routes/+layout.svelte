<script lang="ts">
	import '../app.css';
	import { applyAppearance, readAppearance } from '$lib/client/theme';
	import type { Snippet } from 'svelte';

	let { children, data }: { children: Snippet; data: { locale: string } } = $props();

	// Applied on mount rather than from an inline script in app.html: `kit.csp`
	// runs `script-src 'self'` with hashes for SvelteKit's own payload, and an
	// inline script of ours would need a hash it cannot get. The cost is a brief
	// flash for the minority who override the OS setting — 'auto' sets no
	// attribute at all, so it matches prefers-color-scheme from the first paint.
	$effect(() => {
		applyAppearance(readAppearance());
	});

	// §8.5. The SSR'd document is already labelled correctly — `hooks.server.ts`
	// substitutes `%zembil.lang%` per request — but changing language inside the
	// app is a client-side navigation, which re-runs `load` and re-renders the
	// body while leaving <html> exactly as it was served. Without this the
	// attribute silently disagrees with the text underneath it, and a screen
	// reader keeps using the old language's pronunciation for the rest of the
	// session.
	$effect(() => {
		document.documentElement.lang = data.locale;
	});
</script>

{@render children()}
