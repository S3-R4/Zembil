<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { connectRealtime } from '$lib/client/realtime';
	import { forgetLists, listFor, revalidateAll, shops } from '$lib/client/app.svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	// One EventSource for the whole signed-in app, opened here rather than per
	// page: §4 caps a session at four concurrent streams, and a stream per screen
	// would spend that cap on navigation alone.
	$effect(() => {
		return connectRealtime({
			storeChanged(storeId, rev) {
				// The hint carries a rev, not data. `onStoreChanged` skips the fetch
				// when it is a rev we already have — which is exactly the echo of our
				// own write.
				void listFor(storeId).onStoreChanged(rev);
				if (rev > shops.revOf(storeId)) void shops.load();
			},
			storesChanged() {
				void shops.load();
			},
			async sessionRevoked() {
				// Signed out elsewhere, or disabled by an admin. Drop every cached
				// list before leaving, or the next member to sign in on this device
				// sees the previous one's shopping.
				forgetLists();
				await invalidateAll();
				await goto('/login', { replaceState: true });
			},
			revalidate() {
				// §4, and it must cover the list on screen too — see `revalidateAll`.
				revalidateAll();
			}
		});
	});
</script>

<div class="shell">
	{@render children()}
</div>
<BottomNav />

<style>
	.shell {
		min-height: 100dvh;
		/* Room for the fixed nav plus the primary action that floats above it. */
		padding-bottom: calc(82px + env(safe-area-inset-bottom));
	}
</style>
