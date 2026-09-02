<!--
  docs/DESIGN.md §3, §5. 82px plus the safe-area inset, because on a phone with
  a home indicator the bottom 34px belong to the OS and a tab placed there is a
  tab that swipes the app away instead.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { messages } from '$lib/client/i18n';

	const m = $derived(messages());

	// Labels are read from the catalogue at render time rather than baked into
	// the array, so a language change re-labels the nav without remounting it.
	const tabs = [
		{ href: '/', label: () => m.navShops, match: (p: string) => p === '/' || p.startsWith('/s/') },
		{ href: '/trips', label: () => m.navTrips, match: (p: string) => p.startsWith('/trips') },
		{ href: '/you', label: () => m.navYou, match: (p: string) => p.startsWith('/you') }
	];
</script>

<nav aria-label={m.navMain}>
	{#each tabs as tab (tab.href)}
		{@const active = tab.match(page.url.pathname)}
		<a href={tab.href} class="tab" class:active aria-current={active ? 'page' : undefined}>
			{tab.label()}
		</a>
	{/each}
</nav>

<style>
	nav {
		position: fixed;
		inset: auto 0 0;
		z-index: 20;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
		height: calc(82px + env(safe-area-inset-bottom));
		padding: 11px 16px env(safe-area-inset-bottom);
		background: var(--surface);
		border-top: 1px solid var(--rule);
	}

	.tab {
		display: grid;
		place-items: center;
		height: 60px;
		border-radius: 16px;
		text-decoration: none;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 600;
	}

	.tab.active {
		background: var(--accent-tint);
		color: var(--accent-deep);
		font-weight: 700;
	}
</style>
