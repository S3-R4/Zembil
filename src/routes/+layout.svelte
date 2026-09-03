<script lang="ts">
	import '../app.css';
	import { applyTheme, asTheme } from '$lib/client/theme';
	import type { Snippet } from 'svelte';

	let { children, data }: { children: Snippet; data: { locale: string; theme: string } } =
		$props();

	// The theme is already on <html> when this document arrives — the server put
	// it there (§10.1), which is what removed the old one-frame flash. This
	// effect is for the OTHER path: picking a new theme on /you re-runs the root
	// load and re-renders the body, but <html> is still the element that was
	// served. Exactly the same asymmetry as `lang` below.
	$effect(() => {
		applyTheme(asTheme(data.theme));
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
